import { GmailApiError } from "../gmail";
import { GoogleOAuthRequestError } from "../google/oauth";
import { GmailPayloadError, clampInitialSyncLimit, normalizeFullGmailThread } from "./parser";
import type {
  GmailSyncProvider,
  GmailSyncRepository,
  GmailSyncTarget,
  ManualGmailSyncResult,
} from "./types";

export type ManualGmailSyncErrorCode =
  | "FEATURE_DISABLED"
  | "IDEMPOTENCY_CONFLICT"
  | "MAILBOX_REAUTH_REQUIRED"
  | "MAILBOX_UNAVAILABLE"
  | "SYNC_ABORTED"
  | "SYNC_FAILED"
  | "TOKEN_REFRESH_FAILED"
  | "GMAIL_PAYLOAD_INVALID"
  | "GMAIL_ABORTED"
  | "GMAIL_HTTP_ERROR"
  | "GMAIL_NETWORK_ERROR"
  | "GMAIL_PROTOCOL_ERROR"
  | "GMAIL_TIMEOUT"
  | "GMAIL_VALIDATION_ERROR";

export class ManualGmailSyncError extends Error {
  readonly code: ManualGmailSyncErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: ManualGmailSyncErrorCode, options?: { status?: number; retryable?: boolean }) {
    super("The Gmail synchronization could not be completed safely.");
    this.name = "ManualGmailSyncError";
    this.code = code;
    this.status = options?.status ?? 500;
    this.retryable = options?.retryable ?? false;
  }
}

function safeSyncError(error: unknown): ManualGmailSyncError {
  if (error instanceof ManualGmailSyncError) return error;
  if (error instanceof GmailPayloadError) {
    return new ManualGmailSyncError("GMAIL_PAYLOAD_INVALID", { status: 502 });
  }
  if (error instanceof GmailApiError) {
    return new ManualGmailSyncError(error.code, {
      status: error.code === "GMAIL_ABORTED" ? 499 : 502,
      retryable: error.retryable,
    });
  }
  if (error instanceof GoogleOAuthRequestError) {
    return new ManualGmailSyncError("TOKEN_REFRESH_FAILED", {
      status: error.status === 400 || error.status === 401 ? 409 : 502,
      retryable: error.retryable,
    });
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ManualGmailSyncError("SYNC_ABORTED", { status: 499 });
  }
  return new ManualGmailSyncError("SYNC_FAILED");
}

function newestHistoryId(values: Array<string | undefined>): string | undefined {
  const valid = values.filter((value): value is string => Boolean(value && /^\d+$/u.test(value)));
  return valid.reduce<string | undefined>((largest, value) => {
    if (!largest) return value;
    try {
      return BigInt(value) > BigInt(largest) ? value : largest;
    } catch {
      return largest;
    }
  }, undefined);
}

export async function executeManualGmailSync(
  input: {
    enabled: boolean;
    tenantId: string;
    mailboxId: string;
    actorId: string;
    idempotencyKey: string;
    signal?: AbortSignal;
  },
  dependencies: {
    repository: GmailSyncRepository;
    createProvider(target: GmailSyncTarget): Promise<GmailSyncProvider>;
    now?: () => Date;
  },
): Promise<ManualGmailSyncResult> {
  if (!input.enabled) {
    throw new ManualGmailSyncError("FEATURE_DISABLED", { status: 503 });
  }

  const target = await dependencies.repository.findSyncTarget(input.tenantId, input.mailboxId);
  if (!target) {
    // Deliberately does not reveal whether another tenant owns this mailbox.
    throw new ManualGmailSyncError("MAILBOX_UNAVAILABLE", { status: 404 });
  }

  const startedAt = dependencies.now?.() ?? new Date();
  const begun = await dependencies.repository.beginSyncRun({
    tenantId: input.tenantId,
    mailboxId: input.mailboxId,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    now: startedAt,
  });
  if (!begun.created) {
    return {
      runId: begun.run.id,
      status: begun.run.status,
      replayed: true,
      importedThreads: begun.run.importedThreads,
      importedMessages: begun.run.importedMessages,
      errorCode: begun.run.errorCode,
    };
  }

  let importedThreads = 0;
  let importedMessages = 0;
  const historyIds: Array<string | undefined> = [];

  try {
    await dependencies.repository.audit({
      tenantId: input.tenantId,
      actorId: input.actorId,
      runId: begun.run.id,
      mailboxId: input.mailboxId,
      idempotencyKey: input.idempotencyKey,
      phase: "started",
    });
    const provider = await dependencies.createProvider(target);
    const limit = clampInitialSyncLimit(target.initialSyncLimit);
    const listed = await provider.listRecentInboxThreads({ maxResults: limit, signal: input.signal });
    const references = (listed.threads ?? []).slice(0, limit);

    for (const reference of references) {
      if (!reference.id) throw new GmailPayloadError();
      const complete = await provider.getFullThread(reference.id, { signal: input.signal });
      if (complete.id !== reference.id) throw new GmailPayloadError();
      const normalized = await normalizeFullGmailThread(complete, {
        now: dependencies.now?.() ?? startedAt,
        retentionDays: target.contentRetentionDays,
      });
      const persisted = await dependencies.repository.upsertThread({
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        thread: normalized,
        now: dependencies.now?.() ?? startedAt,
      });
      if (persisted.threadCreated) importedThreads += 1;
      importedMessages += persisted.messagesCreated;
      historyIds.push(reference.historyId, normalized.providerHistoryId);
    }

    const completedAt = dependencies.now?.() ?? new Date();
    await dependencies.repository.completeSyncRun({
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      runId: begun.run.id,
      importedThreads,
      importedMessages,
      providerHistoryId: newestHistoryId(historyIds),
      now: completedAt,
    });
    await dependencies.repository.audit({
      tenantId: input.tenantId,
      actorId: input.actorId,
      runId: begun.run.id,
      mailboxId: input.mailboxId,
      idempotencyKey: input.idempotencyKey,
      phase: "completed",
      importedThreads,
      importedMessages,
    });

    return {
      runId: begun.run.id,
      status: "succeeded",
      replayed: false,
      importedThreads,
      importedMessages,
    };
  } catch (error) {
    const safeError = safeSyncError(error);
    const failedAt = dependencies.now?.() ?? new Date();
    try {
      await dependencies.repository.failSyncRun({
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        runId: begun.run.id,
        errorCode: safeError.code,
        now: failedAt,
      });
    } catch {
      // Preserve the redacted provider failure even when run-state persistence is unavailable.
    }
    try {
      await dependencies.repository.audit({
        tenantId: input.tenantId,
        actorId: input.actorId,
        runId: begun.run.id,
        mailboxId: input.mailboxId,
        idempotencyKey: input.idempotencyKey,
        phase: "failed",
        importedThreads,
        importedMessages,
        errorCode: safeError.code,
      });
    } catch {
      // Never replace a safe public error with database or audit-chain details.
    }
    throw safeError;
  }
}
