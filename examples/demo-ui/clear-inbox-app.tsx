"use client";

import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  BadgeCheck,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Clock3,
  Command,
  CreditCard,
  FileCheck2,
  FileText,
  Filter,
  Inbox,
  LifeBuoy,
  ListFilter,
  LockKeyhole,
  Mail,
  Menu,
  MessageSquareReply,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  Reply,
  Search,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Tag,
  UserRound,
  Users,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { demoMessages, inboxCounts, initialAuditEvents } from "./demo-data";
import type { AuditEvent, InboxMessage, Priority } from "@/lib/types";

export type ClearInboxView = "triage" | "approvals" | "drafts" | "audit" | "automation";
type View = ClearInboxView;
type QueueFilter = "attention" | "all" | "critical" | "waiting";
type DetailTab = "overview" | "thread" | "activity";

const avatarTones = ["plum", "blue", "mint", "amber", "rose", "slate"];

const navGroups = [
  {
    label: "Workspace",
    items: [
      { id: "triage" as View, label: "Triage", icon: Inbox, count: inboxCounts.needsAttention },
      {
        id: "approvals" as View,
        label: "Approvals",
        icon: ClipboardCheck,
        count: inboxCounts.approvals,
      },
      { id: "drafts" as View, label: "Drafts", icon: PenLine, count: inboxCounts.drafts },
      { id: "audit" as View, label: "Audit log", icon: FileCheck2 },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { id: "triage" as View, label: "Sales leads", icon: BriefcaseBusiness, count: inboxCounts.sales },
      { id: "triage" as View, label: "Customer issues", icon: LifeBuoy, count: inboxCounts.support },
      { id: "triage" as View, label: "Invoices", icon: CreditCard, count: inboxCounts.invoices },
      { id: "triage" as View, label: "Security flags", icon: ShieldAlert, count: inboxCounts.security },
    ],
  },
];

const viewMeta: Record<View, { eyebrow: string; title: string; description: string }> = {
  triage: {
    eyebrow: "Thursday, 6 August",
    title: "Inbox, understood.",
    description: "Every message that needs a human decision, already prioritised.",
  },
  approvals: {
    eyebrow: "Human review",
    title: "Approval queue",
    description: "Review the exact action, recipients and evidence before anything leaves your business.",
  },
  drafts: {
    eyebrow: "Prepared responses",
    title: "Draft workspace",
    description: "Replies grounded in the thread, with unknowns kept explicit.",
  },
  audit: {
    eyebrow: "Operational record",
    title: "Audit log",
    description: "A complete, tenant-scoped history of every proposal and decision.",
  },
  automation: {
    eyebrow: "Policy controls",
    title: "Automation",
    description: "Safe defaults, deterministic guardrails and human control over every capability.",
  },
};

function PriorityBadge({ priority }: { priority: Priority }) {
  return <span className={`priority-badge priority-${priority}`}>{priority}</span>;
}

function StatusPill({ status }: { status: InboxMessage["status"] }) {
  const labels: Record<InboxMessage["status"], string> = {
    "needs-review": "Needs review",
    "draft-ready": "Draft ready",
    waiting: "Waiting",
    escalated: "Escalated",
    resolved: "Resolved",
  };
  return <span className={`status-pill status-${status}`}>{labels[status]}</span>;
}

function AppLogo() {
  return (
    <div className="brand-lockup" aria-label="ClearInbox home">
      <span className="brand-mark">
        <span />
        <span />
        <span />
      </span>
      <span className="brand-name">clearinbox</span>
    </div>
  );
}

function Sidebar({
  activeView,
  onNavigate,
  open,
  onClose,
}: {
  activeView: View;
  onNavigate: (view: View, label?: string) => void;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <div className="sidebar-topline">
          <AppLogo />
          <button className="icon-button sidebar-close" onClick={onClose} aria-label="Close navigation">
            <X size={18} />
          </button>
        </div>

        <button className="tenant-switcher">
          <span className="tenant-logo">N</span>
          <span className="tenant-copy">
            <strong>Northstar Goods</strong>
            <small>Operations workspace</small>
          </span>
          <ChevronDown size={15} />
        </button>

        <nav className="sidebar-nav" aria-label="Main navigation">
          {navGroups.map((group) => (
            <div className="nav-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item, index) => {
                const Icon = item.icon;
                const active = activeView === item.id && (group.label === "Workspace" || index === -1);
                return (
                  <button
                    className={`nav-item ${active ? "active" : ""}`}
                    key={`${group.label}-${item.label}`}
                    onClick={() => {
                      onNavigate(item.id, item.label);
                      onClose();
                    }}
                  >
                    <Icon size={17} strokeWidth={1.8} />
                    <span>{item.label}</span>
                    {item.count ? <em>{item.count}</em> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <button className="safe-mode-card" onClick={() => onNavigate("automation")}>
            <span className="safe-icon">
              <ShieldCheck size={17} />
            </span>
            <span>
              <strong>Safe Mode</strong>
              <small>External send is off</small>
            </span>
            <ChevronRight size={15} />
          </button>
          <div className="profile-row">
            <span className="profile-avatar">AM</span>
            <span>
              <strong>Alex Morgan</strong>
              <small>Workspace admin</small>
            </span>
            <Settings2 size={17} />
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({
  view,
  query,
  onQuery,
  onOpenNav,
  onToast,
}: {
  view: View;
  query: string;
  onQuery: (query: string) => void;
  onOpenNav: () => void;
  onToast: (message: string) => void;
}) {
  const meta = viewMeta[view];
  return (
    <header className="topbar">
      <div className="topbar-title">
        <button className="icon-button mobile-menu" onClick={onOpenNav} aria-label="Open navigation">
          <Menu size={20} />
        </button>
        <div>
          <p>{meta.eyebrow}</p>
          <h1>{meta.title}</h1>
          <span>{meta.description}</span>
        </div>
      </div>
      <div className="topbar-actions">
        {view === "triage" ? (
          <label className="global-search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="Search people, subjects, accounts…"
              aria-label="Search inbox"
            />
            <kbd>
              <Command size={12} />K
            </kbd>
          </label>
        ) : null}
        <span className="simulation-chip">
          <span /> Simulation
        </span>
        <button className="icon-button notification-button" onClick={() => onToast("You’re all caught up on notifications.")}>
          <Bell size={18} />
          <span />
        </button>
        <button className="top-avatar" aria-label="Open account menu">AM</button>
      </div>
    </header>
  );
}

function QueueCard({
  message,
  selected,
  index,
  onClick,
}: {
  message: InboxMessage;
  selected: boolean;
  index: number;
  onClick: () => void;
}) {
  return (
    <button className={`queue-card ${selected ? "selected" : ""}`} onClick={onClick}>
      <span className={`message-avatar avatar-${avatarTones[index % avatarTones.length]}`}>
        {message.initials}
        {message.unread ? <i /> : null}
      </span>
      <span className="queue-card-body">
        <span className="queue-card-line">
          <strong>{message.sender}</strong>
          <time>{message.receivedAt}</time>
        </span>
        <span className="message-company">{message.company}</span>
        <span className="message-subject">{message.subject}</span>
        <span className="message-preview">{message.preview}</span>
        <span className="queue-card-meta">
          <PriorityBadge priority={message.priority} />
          <span>{message.category}</span>
          {message.attachments.length > 0 ? (
            <span className="attachment-count">
              <Paperclip size={12} /> {message.attachments.length}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

function InboxQueue({
  messages,
  selectedId,
  onSelect,
  filter,
  onFilter,
}: {
  messages: InboxMessage[];
  selectedId: string;
  onSelect: (id: string) => void;
  filter: QueueFilter;
  onFilter: (filter: QueueFilter) => void;
}) {
  const tabs: { id: QueueFilter; label: string }[] = [
    { id: "attention", label: "Attention" },
    { id: "all", label: "All" },
    { id: "critical", label: "Critical" },
    { id: "waiting", label: "Waiting" },
  ];

  return (
    <section className="queue-panel">
      <div className="queue-toolbar">
        <div>
          <span className="section-kicker">Smart queue</span>
          <h2>Needs attention <em>{messages.length}</em></h2>
        </div>
        <button className="icon-button" aria-label="Filter queue">
          <ListFilter size={17} />
        </button>
      </div>
      <div className="queue-tabs" role="tablist" aria-label="Queue filters">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={filter === tab.id ? "active" : ""}
            onClick={() => onFilter(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="queue-list">
        {messages.length > 0 ? (
          messages.map((message, index) => (
            <QueueCard
              key={message.id}
              message={message}
              selected={message.id === selectedId}
              index={index}
              onClick={() => onSelect(message.id)}
            />
          ))
        ) : (
          <div className="empty-state compact">
            <Search size={24} />
            <strong>No messages found</strong>
            <span>Try another search or queue filter.</span>
          </div>
        )}
      </div>
      <div className="queue-footer">
        <Sparkles size={14} />
        <span>Prioritised using tenant rules and full-thread context</span>
      </div>
    </section>
  );
}

function RiskBanner({ message }: { message: InboxMessage }) {
  if (message.riskLevel === "none") return null;
  const blocked = message.riskLevel === "blocked";
  return (
    <div className={`risk-banner ${blocked ? "risk-blocked" : "risk-review"}`}>
      <span>{blocked ? <ShieldAlert size={18} /> : <AlertTriangle size={18} />}</span>
      <div>
        <strong>{blocked ? "Automatic actions blocked" : "Human review required"}</strong>
        <p>
          {blocked
            ? "This thread contains a high-risk request. Replying and forwarding are disabled until specialist review."
            : "The message has material operational or financial impact. Verify the missing facts before responding."}
        </p>
      </div>
      <small>{message.riskFlags.length} {message.riskFlags.length === 1 ? "flag" : "flags"}</small>
    </div>
  );
}

function AttachmentRow({ attachment }: { attachment: InboxMessage["attachments"][number] }) {
  const icon = attachment.risk === "quarantined" ? <ShieldAlert size={18} /> : <FileText size={18} />;
  return (
    <div className={`attachment-row attachment-${attachment.risk}`}>
      <span className="attachment-icon">{icon}</span>
      <span>
        <strong>{attachment.name}</strong>
        <small>{attachment.type} · {attachment.size}</small>
      </span>
      <em>
        {attachment.risk === "safe" ? <CheckCircle2 size={13} /> : <LockKeyhole size={13} />}
        {attachment.risk === "safe" ? "Scanned" : attachment.risk === "review" ? "Review" : "Quarantined"}
      </em>
    </div>
  );
}

function MessageThread({ message, compact = false }: { message: InboxMessage; compact?: boolean }) {
  return (
    <div className={`thread-stack ${compact ? "thread-compact" : ""}`}>
      {message.thread.map((entry) => (
        <article className="email-message" key={entry.id}>
          <header>
            <span className="mini-avatar">{message.initials}</span>
            <span>
              <strong>{entry.sender}</strong>
              <small>{entry.email}</small>
            </span>
            <time>{entry.timestamp}</time>
            <button className="icon-button" aria-label="Message options">
              <MoreHorizontal size={17} />
            </button>
          </header>
          <div className="email-body">
            {entry.body.map((paragraph, index) => (
              <p key={`${entry.id}-${index}`}>
                {paragraph.split("\n").map((line, lineIndex) => (
                  <span key={lineIndex}>
                    {line}
                    {lineIndex < paragraph.split("\n").length - 1 ? <br /> : null}
                  </span>
                ))}
              </p>
            ))}
          </div>
          {message.attachments.length > 0 ? (
            <div className="attachment-list">
              {message.attachments.map((attachment) => (
                <AttachmentRow attachment={attachment} key={attachment.name} />
              ))}
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

function IntelligencePanel({ message }: { message: InboxMessage }) {
  return (
    <aside className="intelligence-panel">
      <div className="intelligence-heading">
        <span className="ai-orb"><WandSparkles size={16} /></span>
        <div>
          <strong>ClearInbox brief</strong>
          <small>Internal · never shown to sender</small>
        </div>
        <span className="confidence-score">{message.confidence}%</span>
      </div>

      <div className="intelligence-section summary-section">
        <span>What matters</span>
        <p>{message.summary}</p>
      </div>

      <div className="intelligence-section">
        <span>Requested outcome</span>
        <p className="intent-line">{message.intent}</p>
      </div>

      {message.riskFlags.length > 0 ? (
        <div className="intelligence-section">
          <span>Risk signals</span>
          <div className="risk-tags">
            {message.riskFlags.map((flag) => (
              <em key={flag}><ShieldAlert size={12} /> {flag}</em>
            ))}
          </div>
        </div>
      ) : null}

      <div className="intelligence-section">
        <span>Verified from this thread</span>
        <ul className="fact-list">
          {message.facts.map((fact) => (
            <li key={fact}><Check size={14} /> <span>{fact}</span></li>
          ))}
        </ul>
      </div>

      {message.extracted.length > 0 ? (
        <div className="intelligence-section">
          <span>Extracted details</span>
          <dl className="entity-grid">
            {message.extracted.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>
                  {item.value}
                  {item.verified ? <BadgeCheck size={13} /> : <CircleAlert size={13} />}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {message.missingInformation.length > 0 ? (
        <div className="missing-card">
          <CircleAlert size={15} />
          <div>
            <strong>Still unverified</strong>
            <p>{message.missingInformation.join(" · ")}</p>
          </div>
        </div>
      ) : null}

      <div className="policy-footnote">
        <ShieldCheck size={14} />
        <span>{message.auditReason}</span>
      </div>
    </aside>
  );
}

function DraftCard({
  message,
  draftValue,
  editing,
  onEdit,
  onChange,
}: {
  message: InboxMessage;
  draftValue: string;
  editing: boolean;
  onEdit: () => void;
  onChange: (value: string) => void;
}) {
  if (!message.draft) return null;
  return (
    <section className="draft-card">
      <header>
        <span className="draft-icon"><MessageSquareReply size={17} /></span>
        <span>
          <strong>Proposed reply</strong>
          <small>Draft v1 · grounded in this thread</small>
        </span>
        <button className="text-button" onClick={onEdit}>
          <PenLine size={14} /> {editing ? "Done editing" : "Edit"}
        </button>
      </header>
      <div className="draft-recipient">
        <span>To</span>
        <strong>{message.sender} &lt;{message.email}&gt;</strong>
        <em>Reply only</em>
      </div>
      {editing ? (
        <textarea
          className="draft-editor"
          aria-label="Edit reply draft"
          value={draftValue}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <div className="draft-body">
          {draftValue.split("\n\n").map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      )}
      <footer>
        <span><ShieldCheck size={14} /> No unsupported promise detected</span>
        <button><Plus size={14} /> Add note</button>
      </footer>
    </section>
  );
}

function MessageDetail({
  message,
  tab,
  onTab,
  onApprove,
  onEscalate,
  onArchive,
  onBack,
  events,
  approved,
}: {
  message: InboxMessage;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  onApprove: () => void;
  onEscalate: () => void;
  onArchive: () => void;
  onBack: () => void;
  events: AuditEvent[];
  approved: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const initialDraft = message.draft
    ? [...message.draft.body, message.draft.signature].join("\n\n")
    : "";
  const [draftValue, setDraftValue] = useState(initialDraft);

  return (
    <main className="detail-panel">
      <div className="detail-header">
        <button className="icon-button detail-back" onClick={onBack} aria-label="Back to queue">
          <ArrowLeft size={18} />
        </button>
        <span className="detail-avatar">{message.initials}</span>
        <div className="detail-title">
          <span className="detail-sender-line">
            <strong>{message.sender}</strong>
            <small>{message.company}</small>
          </span>
          <h2>{message.subject}</h2>
          <span className="detail-meta-line">
            <PriorityBadge priority={message.priority} />
            <span>{message.category}</span>
            <span>·</span>
            <span>{message.relationship}</span>
          </span>
        </div>
        <div className="detail-actions">
          <StatusPill status={approved ? "waiting" : message.status} />
          <button className="secondary-button" onClick={onEscalate}>
            <UserRound size={15} /> Assign
          </button>
          <button className="icon-button" aria-label="More actions"><MoreHorizontal size={18} /></button>
        </div>
      </div>

      <div className="detail-tabbar">
        {(["overview", "thread", "activity"] as DetailTab[]).map((item) => (
          <button key={item} className={tab === item ? "active" : ""} onClick={() => onTab(item)}>
            {item === "overview" ? "Overview" : item === "thread" ? "Full thread" : "Activity"}
            {item === "activity" ? <span>{events.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === "overview" ? (
        <>
          <div className="detail-scroll overview-grid">
            <div className="conversation-column">
              <RiskBanner message={message} />
              <MessageThread message={message} compact />
              <DraftCard
                message={message}
                draftValue={draftValue}
                editing={editing}
                onEdit={() => setEditing((value) => !value)}
                onChange={setDraftValue}
              />
              {!message.draft ? (
                <div className="no-draft-card">
                  <LockKeyhole size={19} />
                  <div>
                    <strong>No reply drafted</strong>
                    <p>Reply generation is blocked for this risk category until specialist review.</p>
                  </div>
                </div>
              ) : null}
            </div>
            <IntelligencePanel message={message} />
          </div>
          <div className="decision-bar">
            <div className="decision-policy">
              <span><ShieldCheck size={17} /></span>
              <div>
                <strong>{approved ? "Draft approved — send still protected" : "Safe Mode is protecting this action"}</strong>
                <small>{approved ? "No external email was sent in this simulation." : "Approval records the decision; it does not bypass specialist blocks."}</small>
              </div>
            </div>
            <button className="secondary-button archive-action" onClick={onArchive}>
              <Archive size={15} /> Archive
            </button>
            {message.riskLevel === "blocked" ? (
              <button className="primary-button danger-action" onClick={onEscalate}>
                <ShieldAlert size={16} /> Escalate now
              </button>
            ) : (
              <button className="primary-button" onClick={onApprove} disabled={approved || !message.draft}>
                {approved ? <CheckCircle2 size={16} /> : <ClipboardCheck size={16} />}
                {approved ? "Approved" : "Approve draft"}
              </button>
            )}
          </div>
        </>
      ) : null}

      {tab === "thread" ? (
        <div className="detail-scroll single-column-view">
          <div className="full-thread-heading">
            <div><span className="section-kicker">Complete context</span><h3>{message.thread.length} message in this thread</h3></div>
            <button className="secondary-button"><Reply size={15} /> Reply</button>
          </div>
          <MessageThread message={message} />
        </div>
      ) : null}

      {tab === "activity" ? (
        <div className="detail-scroll single-column-view">
          <div className="full-thread-heading">
            <div><span className="section-kicker">Decision history</span><h3>Message activity</h3></div>
            <span className="immutable-chip"><LockKeyhole size={13} /> Append-only</span>
          </div>
          <AuditTimeline events={events} compact />
        </div>
      ) : null}
    </main>
  );
}

function AuditTimeline({ events, compact = false }: { events: AuditEvent[]; compact?: boolean }) {
  return (
    <div className={`audit-timeline ${compact ? "audit-compact" : ""}`}>
      {events.map((event) => (
        <article className="audit-entry" key={event.id}>
          <span className={`audit-dot audit-${event.tone}`}>
            {event.tone === "success" ? <Check size={13} /> : event.tone === "danger" ? <ShieldAlert size={13} /> : <Zap size={13} />}
          </span>
          <div>
            <header><strong>{event.action}</strong><time>{event.time}</time></header>
            <p>{event.detail}</p>
            <small>{event.actor}</small>
          </div>
        </article>
      ))}
    </div>
  );
}

function ApprovalView({
  messages,
  onOpen,
  onApprove,
}: {
  messages: InboxMessage[];
  onOpen: (id: string) => void;
  onApprove: (message: InboxMessage) => void;
}) {
  const approvalMessages = messages.filter(
    (message) => message.draft && message.status !== "resolved",
  ).slice(0, 4);
  return (
    <div className="page-scroll view-page approvals-page">
      <section className="metric-strip">
        <div><span className="metric-icon lavender"><ClipboardCheck size={18} /></span><strong>4</strong><small>Awaiting your decision</small></div>
        <div><span className="metric-icon amber"><Clock3 size={18} /></span><strong>18m</strong><small>Median review time</small></div>
        <div><span className="metric-icon mint"><ShieldCheck size={18} /></span><strong>100%</strong><small>Actions policy-checked</small></div>
      </section>

      <div className="view-toolbar">
        <div><span className="section-kicker">Exact-action review</span><h2>Waiting for approval</h2></div>
        <div><button className="secondary-button"><Filter size={15} /> Filter</button><button className="secondary-button"><Users size={15} /> My queue</button></div>
      </div>

      <section className="approval-list">
        {approvalMessages.map((message, index) => (
          <article className="approval-card" key={message.id}>
            <span className={`message-avatar avatar-${avatarTones[index % avatarTones.length]}`}>{message.initials}</span>
            <div className="approval-main">
              <header>
                <div><strong>{message.sender}</strong><span>{message.company}</span></div>
                <PriorityBadge priority={message.priority} />
              </header>
              <h3>{message.subject}</h3>
              <p>{message.summary}</p>
              <div className="approval-policy-row">
                <span><Mail size={14} /> Reply to {message.email}</span>
                <span><ShieldCheck size={14} /> {message.riskLevel === "none" ? "Standard approval" : "Heightened review"}</span>
                <span><BadgeCheck size={14} /> {message.confidence}% confidence</span>
              </div>
            </div>
            <div className="approval-actions">
              <button className="secondary-button" onClick={() => onOpen(message.id)}>Review</button>
              <button className="primary-button" onClick={() => onApprove(message)} disabled={message.riskLevel === "blocked"}>
                {message.riskLevel === "blocked" ? <LockKeyhole size={15} /> : <Check size={15} />}
                {message.riskLevel === "blocked" ? "Blocked" : "Approve"}
              </button>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}

function DraftsView({ messages, onOpen }: { messages: InboxMessage[]; onOpen: (id: string) => void }) {
  const drafts = messages.filter((message) => message.draft);
  return (
    <div className="page-scroll view-page drafts-page">
      <div className="view-toolbar">
        <div><span className="section-kicker">Prepared safely</span><h2>{drafts.length} reply drafts</h2></div>
        <button className="secondary-button"><ListFilter size={15} /> Sort by priority</button>
      </div>
      <div className="draft-grid">
        {drafts.map((message, index) => (
          <article className="draft-preview-card" key={message.id}>
            <header>
              <span className={`message-avatar avatar-${avatarTones[index % avatarTones.length]}`}>{message.initials}</span>
              <div><strong>{message.sender}</strong><small>{message.company}</small></div>
              <PriorityBadge priority={message.priority} />
            </header>
            <h3>{message.subject}</h3>
            <p>{message.draft?.body[1] ?? message.draft?.body[0]}</p>
            <div className="draft-preview-meta"><span><BadgeCheck size={14} /> {message.confidence}% grounded</span><StatusPill status={message.status} /></div>
            <footer><span>Updated {message.receivedAt}</span><button onClick={() => onOpen(message.id)}>Review draft <ChevronRight size={15} /></button></footer>
          </article>
        ))}
      </div>
    </div>
  );
}

function AuditView({ events }: { events: AuditEvent[] }) {
  return (
    <div className="page-scroll view-page audit-page">
      <section className="audit-summary-card">
        <div><ShieldCheck size={21} /><span><strong>Audit coverage is on</strong><small>Every proposal, decision and execution result is recorded.</small></span></div>
        <span className="immutable-chip"><LockKeyhole size={13} /> Tenant scoped</span>
      </section>
      <div className="view-toolbar">
        <div><span className="section-kicker">Today</span><h2>Operational activity</h2></div>
        <div className="audit-search"><Search size={15} /><input placeholder="Search events" /></div>
      </div>
      <section className="audit-layout">
        <AuditTimeline events={events} />
        <aside className="audit-sidecard">
          <span className="section-kicker">Policy health</span>
          <h3>All guardrails active</h3>
          <div className="health-meter"><span style={{ width: "100%" }} /></div>
          <ul>
            <li><CheckCircle2 size={15} /> Safe Mode enforced</li>
            <li><CheckCircle2 size={15} /> External sending off</li>
            <li><CheckCircle2 size={15} /> PII redaction on</li>
            <li><CheckCircle2 size={15} /> Approval checks on</li>
          </ul>
          <button className="secondary-button"><BookOpen size={15} /> View policy report</button>
        </aside>
      </section>
    </div>
  );
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      className={`toggle ${checked ? "toggle-on" : ""}`}
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
    ><span /></button>
  );
}

function AutomationView({ onToast }: { onToast: (message: string) => void }) {
  const [settings, setSettings] = useState({
    draft: true,
    label: true,
    send: false,
    archive: false,
    forward: false,
    pii: true,
    audit: true,
  });
  const set = (key: keyof typeof settings) => {
    if (["send", "forward"].includes(key)) {
      onToast("Safe Mode prevents this capability from being enabled.");
      return;
    }
    setSettings((value) => ({ ...value, [key]: !value[key] }));
    onToast("Simulation setting updated. No production policy was changed.");
  };

  return (
    <div className="page-scroll view-page automation-page">
      <section className="mode-banner">
        <div className="mode-shield"><ShieldCheck size={25} /></div>
        <div><span className="section-kicker">Active operating mode</span><h2>Safe Mode</h2><p>ClearInbox can analyse, label and prepare drafts. Every external reply still needs a recorded human decision.</p></div>
        <button className="secondary-button">Review staged rollout <ChevronRight size={15} /></button>
      </section>

      <div className="settings-layout">
        <section className="settings-card">
          <header><div><span className="section-kicker">Capabilities</span><h3>What ClearInbox may do</h3></div><span className="saved-chip"><Check size={13} /> Defaults applied</span></header>
          {[
            { key: "draft" as const, icon: PenLine, title: "Create reply drafts", text: "Prepare grounded replies without sending them." },
            { key: "label" as const, icon: Tag, title: "Apply labels", text: "Organise mail using tenant categories and rules." },
            { key: "send" as const, icon: Send, title: "Send external replies", text: "Disabled by Safe Mode and approval policy.", locked: true },
            { key: "archive" as const, icon: Archive, title: "Archive resolved mail", text: "Move fully processed, low-risk mail from the inbox." },
            { key: "forward" as const, icon: Mail, title: "Forward messages", text: "Disabled until approved internal routes are configured.", locked: true },
          ].map((item) => {
            const Icon = item.icon;
            return (
              <div className="setting-row" key={item.key}>
                <span className="setting-icon"><Icon size={17} /></span>
                <div><strong>{item.title}</strong><small>{item.text}</small></div>
                {item.locked ? <LockKeyhole className="lock-hint" size={14} /> : null}
                <Toggle checked={settings[item.key]} onChange={() => set(item.key)} disabled={item.locked} />
              </div>
            );
          })}
        </section>

        <div className="settings-side">
          <section className="settings-card compact-settings">
            <header><div><span className="section-kicker">Always on</span><h3>Data protection</h3></div></header>
            <div className="setting-row"><span className="setting-icon"><ShieldCheck size={17} /></span><div><strong>PII redaction</strong><small>Protect logs and analytics.</small></div><Toggle checked={settings.pii} onChange={() => set("pii")} /></div>
            <div className="setting-row"><span className="setting-icon"><FileCheck2 size={17} /></span><div><strong>Audit logging</strong><small>Append-only event record.</small></div><Toggle checked={settings.audit} onChange={() => set("audit")} disabled /></div>
          </section>
          <section className="threshold-card">
            <span className="section-kicker">Classification threshold</span>
            <div className="threshold-value"><strong>85%</strong><span>Minimum</span></div>
            <div className="threshold-line"><span style={{ width: "85%" }}><i /></span></div>
            <p>Messages below this threshold become <strong>Review required</strong>. No destructive or external action is eligible.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timeout = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(timeout);
  }, [message, onClose]);
  return (
    <div className="toast" role="status">
      <CheckCircle2 size={18} />
      <span>{message}</span>
      <button onClick={onClose} aria-label="Dismiss notification"><X size={15} /></button>
    </div>
  );
}

export default function ClearInboxApp({
  displayName,
  initialView = "triage",
  initialMessageId,
}: {
  displayName?: string | null;
  initialView?: ClearInboxView;
  initialMessageId?: string;
}) {
  const validInitialMessage = demoMessages.some((message) => message.id === initialMessageId)
    ? initialMessageId
    : undefined;
  const [view, setView] = useState<View>(initialView);
  const [messages, setMessages] = useState(demoMessages);
  const [selectedId, setSelectedId] = useState(validInitialMessage ?? demoMessages[0].id);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QueueFilter>("attention");
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [events, setEvents] = useState(initialAuditEvents);
  const [toast, setToast] = useState("");
  const [navOpen, setNavOpen] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(validInitialMessage));

  const visibleMessages = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return messages.filter((message) => {
      const matchesQuery =
        !normalizedQuery ||
        [message.sender, message.company, message.subject, message.category, message.summary]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      const matchesFilter =
        filter === "all" ||
        (filter === "critical" && message.priority === "critical") ||
        (filter === "waiting" && ["waiting", "draft-ready"].includes(message.status)) ||
        (filter === "attention" && message.status !== "resolved");
      return matchesQuery && matchesFilter;
    });
  }, [filter, messages, query]);

  const selected = messages.find((message) => message.id === selectedId) ?? messages[0];

  const addEvent = (event: Omit<AuditEvent, "id" | "time">) => {
    setEvents((current) => [
      { ...event, id: `audit_${Date.now()}`, time: "Just now" },
      ...current,
    ]);
  };

  const openMessage = (id: string) => {
    setSelectedId(id);
    setDetailTab("overview");
    setMobileDetailOpen(true);
  };

  const approveMessage = (message = selected) => {
    if (message.riskLevel === "blocked") {
      setToast("This action is blocked and must be escalated to the specialist queue.");
      return;
    }
    setApprovedIds((current) => new Set([...current, message.id]));
    setMessages((current) =>
      current.map((item) => (item.id === message.id ? { ...item, status: "waiting" } : item)),
    );
    addEvent({
      action: "Draft approved",
      detail: `The exact reply to ${message.email} was approved for protected execution. No email was sent in simulation.`,
      actor: displayName || "Alex Morgan",
      tone: "success",
    });
    setToast("Draft approved. No external email was sent in this simulation.");
  };

  const escalateMessage = () => {
    setMessages((current) =>
      current.map((message) =>
        message.id === selected.id ? { ...message, status: "escalated" } : message,
      ),
    );
    addEvent({
      action: "Human escalation recorded",
      detail: `${selected.subject} was routed to ${selected.assignee}.`,
      actor: displayName || "Alex Morgan",
      tone: selected.riskLevel === "blocked" ? "danger" : "warning",
    });
    setToast(`Escalation recorded for ${selected.assignee}.`);
  };

  const archiveMessage = () => {
    if (selected.priority === "critical" || selected.status === "escalated" || selected.riskLevel !== "none") {
      setToast("Archive blocked: this message still has a risk, escalation or critical action.");
      return;
    }
    setMessages((current) =>
      current.map((message) =>
        message.id === selected.id ? { ...message, status: "resolved" } : message,
      ),
    );
    addEvent({
      action: "Archive proposed",
      detail: `${selected.subject} was marked resolved and queued for archive review.`,
      actor: displayName || "Alex Morgan",
      tone: "neutral",
    });
    setToast("Marked resolved. Archive remains simulated in Safe Mode.");
  };

  const navigate = (next: View) => {
    setView(next);
    setMobileDetailOpen(false);
  };

  return (
    <div className="app-shell">
      <Sidebar
        activeView={view}
        onNavigate={navigate}
        open={navOpen}
        onClose={() => setNavOpen(false)}
      />
      <div className="workspace-shell">
        <Topbar
          view={view}
          query={query}
          onQuery={setQuery}
          onOpenNav={() => setNavOpen(true)}
          onToast={setToast}
        />

        {view === "triage" ? (
          <div className={`triage-layout ${mobileDetailOpen ? "mobile-detail-visible" : ""}`}>
            <InboxQueue
              messages={visibleMessages}
              selectedId={selected.id}
              onSelect={openMessage}
              filter={filter}
              onFilter={setFilter}
            />
            <MessageDetail
              key={selected.id}
              message={selected}
              tab={detailTab}
              onTab={setDetailTab}
              onApprove={() => approveMessage(selected)}
              onEscalate={escalateMessage}
              onArchive={archiveMessage}
              onBack={() => setMobileDetailOpen(false)}
              events={events.filter((event) => event.detail.toLowerCase().includes(selected.sender.toLowerCase()) || !event.detail.includes("@"))}
              approved={approvedIds.has(selected.id)}
            />
          </div>
        ) : null}
        {view === "approvals" ? (
          <ApprovalView
            messages={messages}
            onOpen={(id) => { setView("triage"); openMessage(id); }}
            onApprove={approveMessage}
          />
        ) : null}
        {view === "drafts" ? (
          <DraftsView messages={messages} onOpen={(id) => { setView("triage"); openMessage(id); }} />
        ) : null}
        {view === "audit" ? <AuditView events={events} /> : null}
        {view === "automation" ? <AutomationView onToast={setToast} /> : null}
      </div>
      {toast ? <Toast message={toast} onClose={() => setToast("")} /> : null}
    </div>
  );
}
