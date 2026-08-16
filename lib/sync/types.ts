import type { GmailThread, GmailThreadList } from "../gmail";

export type GmailSyncRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GmailSyncTarget = {
  tenantId: string;
  mailboxId: string;
  providerMailboxId: string;
  credentialId: string;
  accessTokenEncrypted: string;
  refreshTokenEncrypted?: string;
  tokenExpiresAt: Date;
  initialSyncLimit: number;
  contentRetentionDays: number;
};

export type NormalizedAttachment = {
  providerAttachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
};

export type NormalizedMessage = {
  providerMessageId: string;
  senderName?: string;
  senderEmail: string;
  replyToEmail?: string;
  recipients: string[];
  copiedRecipients: string[];
  subject: string;
  textBody: string;
  snippet: string;
  labels: string[];
  internetMessageId?: string;
  inReplyTo?: string;
  references: string[];
  receivedAt: Date;
  contentRetainUntil: Date;
  contentHash: string;
  attachments: NormalizedAttachment[];
};

export type NormalizedThread = {
  providerThreadId: string;
  subject: string;
  lastMessageAt: Date;
  providerHistoryId?: string;
  messages: NormalizedMessage[];
};

export type SyncRunRecord = {
  id: string;
  tenantId: string;
  mailboxId: string;
  idempotencyKey: string;
  status: GmailSyncRunStatus;
  importedMessages: number;
  importedThreads: number;
  errorCode?: string;
};

export type BeginSyncRunResult = {
  created: boolean;
  run: SyncRunRecord;
};

export type ThreadUpsertResult = {
  threadCreated: boolean;
  messagesCreated: number;
};

export type GmailSyncAuditInput = {
  tenantId: string;
  actorId: string;
  runId: string;
  mailboxId: string;
  idempotencyKey: string;
  phase: "started" | "completed" | "failed";
  importedThreads?: number;
  importedMessages?: number;
  errorCode?: string;
};

export interface GmailSyncRepository {
  findSyncTarget(tenantId: string, mailboxId: string): Promise<GmailSyncTarget | undefined>;
  beginSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    actorId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<BeginSyncRunResult>;
  upsertThread(input: {
    tenantId: string;
    mailboxId: string;
    thread: NormalizedThread;
    now: Date;
  }): Promise<ThreadUpsertResult>;
  completeSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    importedThreads: number;
    importedMessages: number;
    providerHistoryId?: string;
    now: Date;
  }): Promise<void>;
  failSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    errorCode: string;
    now: Date;
  }): Promise<void>;
  audit(input: GmailSyncAuditInput): Promise<void>;
}

export interface GmailSyncProvider {
  listRecentInboxThreads(options: {
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<GmailThreadList>;
  getFullThread(threadId: string, options?: { signal?: AbortSignal }): Promise<GmailThread>;
}

export type ManualGmailSyncResult = {
  runId: string;
  status: GmailSyncRunStatus;
  replayed: boolean;
  importedThreads: number;
  importedMessages: number;
  errorCode?: string;
};
