"use client";

import {
  Activity,
  AlertCircle,
  ArrowLeft,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clock3,
  FileText,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Paperclip,
  Plug,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Unplug,
  UserRound,
  X,
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type AppStage = "loading" | "auth" | "onboarding" | "ready" | "error";
type WorkspaceView = "inbox" | "settings" | "audit";
type Notice = { tone: "success" | "warning" | "error"; message: string };

type TenantSession = {
  tenant: { id: string; name: string; role: "owner" | "reviewer" };
  user: { id: string; email: string };
};

type Mailbox = {
  id: string;
  provider: string;
  address: string;
  displayName: string | null;
  status: "active" | "disconnected" | "error";
  lastSuccessfulSyncAt: string | null;
  connectionErrorCode: string | null;
  disconnectedAt: string | null;
};

type QueueAnalysis = {
  category: string;
  priority: string;
  summary: string;
  confidence: number;
  replyRequired: boolean;
  riskFlagsJson?: string;
};

type QueueMessage = {
  id: string;
  threadId: string;
  senderName: string | null;
  senderEmail: string;
  subject: string;
  snippet: string;
  receivedAt: string;
  ingestionStatus: string;
  threadStatus: string;
  analysis: QueueAnalysis | null;
  draft: { id: string; status: string; currentVersion: number } | null;
};

type ThreadMessage = {
  id: string;
  senderName: string | null;
  senderEmail: string;
  recipients: unknown[];
  copiedRecipients: unknown[];
  subject: string;
  textBody: string;
  receivedAt: string;
};

type Analysis = {
  id: string;
  primaryCategory: string;
  priority: string;
  senderIntent: string;
  summary: string;
  requiredActions: unknown[];
  riskFlags: unknown[];
  detectedDates: unknown[];
  detectedDeadlines: unknown[];
  detectedFinancialAmounts: unknown[];
  confidenceScore: number;
  recommendedAssignee: string | null;
  replyRequired: boolean;
  approvalRequired: boolean;
  suggestedNextAction: string;
  auditReason: string;
};

type Draft = {
  id: string;
  status: string;
  currentVersion: number;
  versionId: string;
  version: number;
  recipients: unknown[];
  subject: string;
  body: string;
  contentHash: string;
  approvalId: string | null;
  approvalStatus: string | null;
  approvalExpiresAt: string | null;
  providerDraftId: string | null;
  providerConfirmed: boolean | null;
};

type MessageDetail = {
  thread: {
    id: string;
    subject: string;
    status: string;
    complete: boolean;
    messages: ThreadMessage[];
  };
  analysis: Analysis | null;
  draft: Draft | null;
  attachments: Array<{
    id: string;
    messageId: string;
    filename: string;
    mimeType: string;
    sizeBytes: number;
    riskLevel: string;
  }>;
  safety: {
    htmlRendered: boolean;
    remoteContentLoaded: boolean;
    attachmentsProcessed: boolean;
  };
};

type Settings = {
  operatingMode: string;
  minimumClassificationConfidence: number;
  initialSyncLimit: number;
  contentRetentionDays: number;
  attachmentsEnabled: boolean;
  retainDraftAfterGmailCreation: boolean;
  businessTimezone: string;
  businessInstructions: string;
  version: number;
  updatedAt: string;
};

type AuditEvent = {
  id: string;
  eventType: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  result: string | null;
  actorType: string;
  actorId: string;
  redactedDetailJson: string;
  correlationId: string | null;
  createdAt: string;
};

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  } & T;
  if (!response.ok) {
    throw new ApiError(
      payload.error || "The request could not be completed safely.",
      response.status,
      payload.code,
    );
  }
  return payload;
}

function idempotencyKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`;
}

function formatDate(value: string | null | undefined, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(
    "en-GB",
    options ?? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function initials(value: string) {
  const useful = value.includes("@") ? value.split("@")[0] : value;
  return (
    useful
      .split(/[\s._-]+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "CI"
  );
}

function stringList(values: unknown[] | undefined) {
  return (values ?? []).filter((value): value is string => typeof value === "string");
}

function friendlyOAuthReason(reason: string | null) {
  const known: Record<string, string> = {
    access_denied: "Google access was not granted.",
    state_invalid: "The connection request expired or could not be verified.",
    state_invalid_or_replayed: "The connection request expired or was already used.",
    insufficient_scope: "Google did not grant the required read and draft permissions.",
    mailbox_already_connected: "That Gmail account is already connected to an organisation.",
  };
  return known[reason ?? ""] ?? "Gmail could not be connected. Please start a new connection attempt.";
}

function Brand() {
  return (
    <div className="secure-brand" aria-label="ClearInbox">
      <span className="secure-brand-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <strong>ClearInbox</strong>
    </div>
  );
}

function FullPageState({
  icon,
  eyebrow,
  title,
  copy,
  children,
}: {
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  copy: string;
  children?: React.ReactNode;
}) {
  return (
    <main className="secure-gate">
      <div className="secure-gate-brand"><Brand /></div>
      <section className="secure-gate-card">
        <span className="secure-gate-icon">{icon}</span>
        <p className="secure-eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="secure-gate-copy">{copy}</p>
        {children}
      </section>
      <p className="secure-gate-foot">
        <ShieldCheck size={14} /> Safe Mode · Gmail draft-only · Nothing is sent
      </p>
    </main>
  );
}

export default function SecureWorkspace({ initialDisplayName }: { initialDisplayName: string | null }) {
  const [stage, setStage] = useState<AppStage>("loading");
  const [stageError, setStageError] = useState("");
  const [session, setSession] = useState<TenantSession | null>(null);
  const [organisationName, setOrganisationName] = useState("");
  const [view, setView] = useState<WorkspaceView>("inbox");
  const [mailbox, setMailbox] = useState<Mailbox | null>(null);
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [detail, setDetail] = useState<MessageDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const loadWorkspace = useCallback(async (activeSession: TenantSession) => {
    const owner = activeSession.tenant.role === "owner";
    const [gmailResult, messagesResult, settingsResult, auditResult] = await Promise.all([
      api<{ mailbox: Mailbox | null }>("/api/gmail/status"),
      api<{ messages: QueueMessage[] }>("/api/messages"),
      api<{ settings: Settings }>("/api/settings"),
      owner ? api<{ events: AuditEvent[] }>("/api/audit") : Promise.resolve({ events: [] }),
    ]);
    setMailbox(gmailResult.mailbox);
    setMessages(messagesResult.messages);
    setSettings(settingsResult.settings);
    setAuditEvents(auditResult.events);
    setSelectedMessageId((current) =>
      current && messagesResult.messages.some((message) => message.id === current)
        ? current
        : messagesResult.messages[0]?.id ?? null,
    );
  }, []);

  const initialise = useCallback(async () => {
    setStage("loading");
    try {
      const activeSession = await api<TenantSession>("/api/tenants");
      setSession(activeSession);
      await loadWorkspace(activeSession);
      setStage("ready");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setStage("auth");
      } else if (error instanceof ApiError && error.status === 403) {
        setStage("onboarding");
        setStageError(error.message);
      } else {
        setStageError(error instanceof Error ? error.message : "ClearInbox could not be loaded.");
        setStage("error");
      }
    }
  }, [loadWorkspace]);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("gmail");
    if (outcome === "connected") {
      setNotice({ tone: "success", message: "Gmail connected. Run a sync when you are ready." });
    } else if (outcome === "error") {
      setNotice({ tone: "error", message: friendlyOAuthReason(url.searchParams.get("reason")) });
    }
    if (outcome) {
      url.searchParams.delete("gmail");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(null), 7000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  const refreshDetail = useCallback(async (messageId: string) => {
    setDetailLoading(true);
    try {
      const result = await api<MessageDetail>(`/api/messages/${encodeURIComponent(messageId)}`);
      setDetail(result);
      setDraftBody(result.draft?.body ?? "");
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The thread could not be loaded.",
      });
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (stage === "ready" && selectedMessageId) void refreshDetail(selectedMessageId);
    if (!selectedMessageId) setDetail(null);
  }, [refreshDetail, selectedMessageId, stage]);

  const refreshWorkspace = useCallback(async () => {
    if (!session) return;
    await loadWorkspace(session);
    if (selectedMessageId) await refreshDetail(selectedMessageId);
  }, [loadWorkspace, refreshDetail, selectedMessageId, session]);

  async function createOrganisation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("onboarding");
    try {
      await api("/api/tenants", {
        method: "POST",
        body: JSON.stringify({ name: organisationName }),
      });
      await initialise();
    } catch (error) {
      setStageError(error instanceof Error ? error.message : "The organisation could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function connectGmail() {
    setBusy("connect");
    try {
      const result = await api<{ authorizationUrl: string }>("/api/gmail/connect", {
        method: "POST",
        body: JSON.stringify({ returnPath: "/" }),
      });
      window.location.assign(result.authorizationUrl);
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Gmail could not be connected.",
      });
      setBusy(null);
    }
  }

  async function syncGmail() {
    if (!mailbox) return;
    setBusy("sync");
    try {
      await api("/api/gmail/sync", {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("sync") },
        body: JSON.stringify({ mailboxId: mailbox.id }),
      });
      await refreshWorkspace();
      setNotice({
        tone: "success",
        message: "Gmail sync completed. Imported messages are ready for review.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Gmail sync did not complete.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function disconnectGmail() {
    if (
      !mailbox ||
      !window.confirm(
        "Disconnect this Gmail account? Imported records remain subject to your retention setting.",
      )
    ) return;
    setBusy("disconnect");
    try {
      await api("/api/gmail/disconnect", {
        method: "POST",
        body: JSON.stringify({ mailboxId: mailbox.id }),
      });
      await refreshWorkspace();
      setNotice({
        tone: "success",
        message: "Gmail disconnected. ClearInbox can no longer access the mailbox.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Gmail could not be disconnected.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function analyseMessage() {
    if (!selectedMessageId) return;
    setBusy("analyse");
    try {
      await api(`/api/messages/${encodeURIComponent(selectedMessageId)}/analyse`, { method: "POST" });
      await refreshWorkspace();
      setNotice({
        tone: "success",
        message: "Analysis complete. Review every detail before approving the draft.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The message could not be analysed.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveDraft() {
    if (!detail?.draft) return;
    setBusy("save-draft");
    try {
      await api(`/api/drafts/${encodeURIComponent(detail.draft.id)}`, {
        method: "PUT",
        body: JSON.stringify({ body: draftBody }),
      });
      if (selectedMessageId) await refreshDetail(selectedMessageId);
      setNotice({
        tone: "success",
        message: "Draft saved as a new version. Any earlier approval is no longer valid.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The draft could not be saved.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function approveDraft() {
    if (!detail?.draft) return;
    setBusy("approve");
    try {
      await api(`/api/drafts/${encodeURIComponent(detail.draft.id)}/approve`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (selectedMessageId) await refreshDetail(selectedMessageId);
      setNotice({
        tone: "success",
        message: "This exact draft version is approved for Gmail draft creation.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The draft could not be approved.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function createGmailDraft() {
    if (!detail?.draft) return;
    setBusy("gmail-draft");
    try {
      await api(`/api/drafts/${encodeURIComponent(detail.draft.id)}/gmail`, {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey("gmail-draft") },
        body: JSON.stringify({}),
      });
      await refreshWorkspace();
      setNotice({ tone: "success", message: "Created in Gmail Drafts. Nothing was sent." });
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "The Gmail draft could not be created safely.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function saveSettings(next: Settings) {
    setBusy("settings");
    try {
      const result = await api<{ settings: Settings }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          minimumClassificationConfidence: next.minimumClassificationConfidence,
          initialSyncLimit: next.initialSyncLimit,
          contentRetentionDays: next.contentRetentionDays,
          retainDraftAfterGmailCreation: next.retainDraftAfterGmailCreation,
          businessTimezone: next.businessTimezone,
          businessInstructions: next.businessInstructions,
        }),
      });
      setSettings(result.settings);
      setNotice({ tone: "success", message: "Safe Mode settings saved." });
      if (session?.tenant.role === "owner") {
        const auditResult = await api<{ events: AuditEvent[] }>("/api/audit");
        setAuditEvents(auditResult.events);
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message: error instanceof Error ? error.message : "Settings could not be saved.",
      });
    } finally {
      setBusy(null);
    }
  }

  const filteredMessages = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return messages;
    return messages.filter((message) =>
      [
        message.senderName,
        message.senderEmail,
        message.subject,
        message.snippet,
        message.analysis?.summary,
      ].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [messages, query]);

  if (stage === "loading") {
    return (
      <FullPageState
        icon={<LoaderCircle className="secure-spin" size={24} />}
        eyebrow="Secure workspace"
        title="Opening ClearInbox"
        copy="Loading your tenant-scoped workspace…"
      />
    );
  }

  if (stage === "auth") {
    return (
      <FullPageState
        icon={<LockKeyhole size={24} />}
        eyebrow="Authentication required"
        title="Open this app from your workspace"
        copy="ClearInbox needs an authenticated workspace identity. No email data is available without it."
      >
        <button className="secure-button primary" onClick={() => void initialise()}>
          <RefreshCw size={15} /> Try again
        </button>
      </FullPageState>
    );
  }

  if (stage === "onboarding") {
    return (
      <FullPageState
        icon={<ShieldCheck size={25} />}
        eyebrow="Private setup"
        title="Create your organisation"
        copy="This creates an isolated workspace and makes your signed-in account its owner. Gmail is connected separately."
      >
        <form className="secure-onboarding-form" onSubmit={createOrganisation}>
          <label htmlFor="organisation-name">Organisation name</label>
          <input
            id="organisation-name"
            value={organisationName}
            onChange={(event) => setOrganisationName(event.target.value)}
            minLength={2}
            maxLength={80}
            placeholder="Acme Operations"
            required
            autoFocus
          />
          {stageError ? <p className="secure-inline-error" role="alert">{stageError}</p> : null}
          <button className="secure-button primary" disabled={busy === "onboarding"}>
            {busy === "onboarding" ? (
              <LoaderCircle className="secure-spin" size={15} />
            ) : (
              <ChevronRight size={15} />
            )}
            Create secure workspace
          </button>
        </form>
      </FullPageState>
    );
  }

  if (stage === "error" || !session) {
    return (
      <FullPageState
        icon={<AlertCircle size={24} />}
        eyebrow="Workspace unavailable"
        title="ClearInbox could not open safely"
        copy={stageError || "A tenant-scoped workspace could not be resolved."}
      >
        <button className="secure-button primary" onClick={() => void initialise()}>
          <RefreshCw size={15} /> Try again
        </button>
      </FullPageState>
    );
  }

  const isOwner = session.tenant.role === "owner";
  const activeMailbox = mailbox?.status === "active";
  const displayName = initialDisplayName || session.user.email;

  return (
    <main className="secure-app">
      <div className="secure-safety-bar" role="status">
        <ShieldCheck size={14} />
        <strong>Safe Mode</strong>
        <span aria-hidden="true">·</span>
        <span>Gmail draft-only</span>
        <span aria-hidden="true">·</span>
        <span>Nothing is sent</span>
      </div>

      <div className="secure-shell">
        <aside className="secure-rail">
          <Brand />
          <div className="secure-tenant-card">
            <span>{initials(session.tenant.name)}</span>
            <div><strong>{session.tenant.name}</strong><small>{session.tenant.role}</small></div>
          </div>
          <nav className="secure-nav" aria-label="Workspace">
            <button className={view === "inbox" ? "active" : ""} onClick={() => setView("inbox")}>
              <Inbox size={17} /><span>Review queue</span><em>{messages.length}</em>
            </button>
            <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
              <Settings2 size={17} /><span>Settings</span>
            </button>
            {isOwner ? (
              <button className={view === "audit" ? "active" : ""} onClick={() => setView("audit")}>
                <Activity size={17} /><span>Audit trail</span>
              </button>
            ) : null}
          </nav>
          <div className={`secure-mailbox-card ${activeMailbox ? "connected" : ""}`}>
            <div className="secure-mailbox-title">
              <Mail size={16} /><strong>Gmail</strong>
              <span>
                {activeMailbox
                  ? "Connected"
                  : mailbox?.status === "error"
                    ? "Needs attention"
                    : "Not connected"}
              </span>
            </div>
            {mailbox ? (
              <p>{mailbox.address}</p>
            ) : (
              <p>Read recent threads and create approved drafts only.</p>
            )}
            {activeMailbox ? (
              <button onClick={() => void disconnectGmail()} disabled={busy === "disconnect"}>
                <Unplug size={13} /> Disconnect
              </button>
            ) : (
              <button onClick={() => void connectGmail()} disabled={busy === "connect"}>
                <Plug size={13} /> Connect Gmail
              </button>
            )}
          </div>
          <div className="secure-profile">
            <span>{initials(displayName)}</span>
            <div><strong>{displayName}</strong><small>{session.user.email}</small></div>
          </div>
        </aside>

        <section className="secure-main">
          <header className="secure-header">
            <div>
              <p className="secure-eyebrow">
                {view === "inbox"
                  ? "Human review workspace"
                  : view === "settings"
                    ? "Organisation policy"
                    : "Accountability record"}
              </p>
              <h1>
                {view === "inbox"
                  ? "Review queue"
                  : view === "settings"
                    ? "Safe Mode settings"
                    : "Audit trail"}
              </h1>
              <p>
                {view === "inbox"
                  ? "Analyse complete threads, review exact draft versions, then create drafts in Gmail."
                  : view === "settings"
                    ? "Only the narrow controls supported by this MVP are available."
                    : "Tenant-scoped records of material actions and outcomes."}
              </p>
            </div>
            <div className="secure-header-actions">
              {view === "inbox" && activeMailbox ? (
                <button
                  className="secure-button secondary"
                  onClick={() => void syncGmail()}
                  disabled={busy === "sync"}
                >
                  {busy === "sync" ? (
                    <LoaderCircle className="secure-spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  Sync Gmail
                </button>
              ) : null}
              {view === "inbox" && !activeMailbox ? (
                <button
                  className="secure-button primary"
                  onClick={() => void connectGmail()}
                  disabled={busy === "connect"}
                >
                  <Plug size={15} /> Connect Gmail
                </button>
              ) : null}
            </div>
          </header>

          {view === "inbox" ? (
            <InboxView
              mailbox={mailbox}
              messages={filteredMessages}
              totalMessages={messages.length}
              query={query}
              setQuery={setQuery}
              selectedMessageId={selectedMessageId}
              selectMessage={(id) => {
                setSelectedMessageId(id);
                setMobileDetailOpen(true);
              }}
              mobileDetailOpen={mobileDetailOpen}
              closeMobileDetail={() => setMobileDetailOpen(false)}
              detail={detail}
              detailLoading={detailLoading}
              draftBody={draftBody}
              setDraftBody={setDraftBody}
              busy={busy}
              onAnalyse={analyseMessage}
              onSaveDraft={saveDraft}
              onApproveDraft={approveDraft}
              onCreateGmailDraft={createGmailDraft}
              onConnect={connectGmail}
              onSync={syncGmail}
            />
          ) : view === "settings" ? (
            <SettingsView
              settings={settings}
              isOwner={isOwner}
              busy={busy}
              onSave={saveSettings}
            />
          ) : (
            <AuditView events={auditEvents} />
          )}
        </section>
      </div>

      {notice ? (
        <div
          className={`secure-toast ${notice.tone}`}
          role={notice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {notice.tone === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{notice.message}</span>
          <button aria-label="Dismiss notification" onClick={() => setNotice(null)}>
            <X size={14} />
          </button>
        </div>
      ) : null}
    </main>
  );
}
