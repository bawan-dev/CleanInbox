import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  attachments,
  mailboxCredentials,
  mailboxes,
  messages,
  syncRuns,
  tenantSettings,
  threads,
} from "../../db/schema";
import { appendAuditEvent } from "../audit";
import { GmailClient } from "../gmail";
import { REDACTED_EMAIL_CONTENT } from "../retention-policy";
import {
  refreshGoogleAccessToken,
  type FetchImplementation,
} from "../google/oauth";
import {
  buildSecretAad,
  decryptSecret,
  encryptSecret,
  SecretDecryptionError,
} from "../security/crypto";
import type { AppEnvironment } from "../security/env";
import { executeManualGmailSync, ManualGmailSyncError } from "./core";
import type {
  BeginSyncRunResult,
  GmailSyncAuditInput,
  GmailSyncRepository,
  GmailSyncTarget,
  ManualGmailSyncResult,
  NormalizedMessage,
  NormalizedThread,
  SyncRunRecord,
  ThreadUpsertResult,
} from "./types";

type Database = ReturnType<typeof getDb>;

function asRunRecord(row: typeof syncRuns.$inferSelect): SyncRunRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    mailboxId: row.mailboxId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    importedMessages: row.importedMessages,
    importedThreads: row.importedThreads,
    errorCode: row.errorCode ?? undefined,
  };
}

export class D1GmailSyncRepository implements GmailSyncRepository {
  readonly #db: Database;

  constructor(db: Database = getDb()) {
    this.#db = db;
  }

  async findSyncTarget(tenantId: string, mailboxId: string): Promise<GmailSyncTarget | undefined> {
    const [row] = await this.#db
      .select({
        tenantId: mailboxes.tenantId,
        mailboxId: mailboxes.id,
        providerMailboxId: mailboxes.providerMailboxId,
        credentialId: mailboxCredentials.id,
        accessTokenEncrypted: mailboxCredentials.accessTokenEncrypted,
        refreshTokenEncrypted: mailboxCredentials.refreshTokenEncrypted,
        tokenExpiresAt: mailboxCredentials.tokenExpiresAt,
        initialSyncLimit: tenantSettings.initialSyncLimit,
        contentRetentionDays: tenantSettings.contentRetentionDays,
      })
      .from(mailboxes)
      .innerJoin(
        mailboxCredentials,
        and(
          eq(mailboxCredentials.mailboxId, mailboxes.id),
          eq(mailboxCredentials.tenantId, tenantId),
        ),
      )
      .leftJoin(
        tenantSettings,
        and(
          eq(tenantSettings.tenantId, mailboxes.tenantId),
          eq(tenantSettings.tenantId, tenantId),
        ),
      )
      .where(
        and(
          eq(mailboxes.id, mailboxId),
          eq(mailboxes.tenantId, tenantId),
          eq(mailboxes.provider, "gmail"),
          eq(mailboxes.status, "active"),
        ),
      )
      .limit(1);

    if (!row) return undefined;
    return {
      tenantId: row.tenantId,
      mailboxId: row.mailboxId,
      providerMailboxId: row.providerMailboxId,
      credentialId: row.credentialId,
      accessTokenEncrypted: row.accessTokenEncrypted,
      refreshTokenEncrypted: row.refreshTokenEncrypted ?? undefined,
      tokenExpiresAt: row.tokenExpiresAt,
      initialSyncLimit: row.initialSyncLimit ?? 25,
      contentRetentionDays: row.contentRetentionDays ?? 30,
    };
  }

  async beginSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    actorId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<BeginSyncRunResult> {
    const runId = crypto.randomUUID();
    const inserted = await this.#db
      .insert(syncRuns)
      .values({
        id: runId,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        idempotencyKey: input.idempotencyKey,
        status: "running",
        requestedBy: input.actorId,
        startedAt: input.now,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [syncRuns.tenantId, syncRuns.idempotencyKey],
      })
      .returning({ id: syncRuns.id });

    const [run] = await this.#db
      .select()
      .from(syncRuns)
      .where(
        and(
          eq(syncRuns.tenantId, input.tenantId),
          eq(syncRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (!run || run.mailboxId !== input.mailboxId) {
      throw new ManualGmailSyncError("IDEMPOTENCY_CONFLICT", { status: 409 });
    }
    return { created: inserted.length === 1, run: asRunRecord(run) };
  }

  async upsertThread(input: {
    tenantId: string;
    mailboxId: string;
    thread: NormalizedThread;
    now: Date;
  }): Promise<ThreadUpsertResult> {
    const newThreadId = crypto.randomUUID();
    const insertedThread = await this.#db
      .insert(threads)
      .values({
        id: newThreadId,
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        providerThreadId: input.thread.providerThreadId,
        subject: input.thread.subject,
        lastMessageAt: input.thread.lastMessageAt,
        providerMessageCount: input.thread.messages.length,
        completeThreadImported: false,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({
        target: [threads.tenantId, threads.mailboxId, threads.providerThreadId],
      })
      .returning({ id: threads.id });

    const [storedThread] = await this.#db
      .select({ id: threads.id })
      .from(threads)
      .where(
        and(
          eq(threads.tenantId, input.tenantId),
          eq(threads.mailboxId, input.mailboxId),
          eq(threads.providerThreadId, input.thread.providerThreadId),
        ),
      )
      .limit(1);
    if (!storedThread) throw new ManualGmailSyncError("SYNC_FAILED");

    await this.#db
      .update(threads)
      .set({
        subject: input.thread.subject,
        lastMessageAt: input.thread.lastMessageAt,
        providerMessageCount: input.thread.messages.length,
        completeThreadImported: false,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(threads.id, storedThread.id),
          eq(threads.tenantId, input.tenantId),
          eq(threads.mailboxId, input.mailboxId),
        ),
      );

    let messagesCreated = 0;
    for (const message of input.thread.messages) {
      const wasCreated = await this.#upsertMessage({
        tenantId: input.tenantId,
        mailboxId: input.mailboxId,
        threadId: storedThread.id,
        message,
        now: input.now,
      });
      if (wasCreated) messagesCreated += 1;
    }

    // This marker is deliberately written last. A failed or interrupted message
    // import leaves the thread visibly incomplete for retry and downstream analysis.
    const markedComplete = await this.#db
      .update(threads)
      .set({
        providerMessageCount: input.thread.messages.length,
        completeThreadImported: true,
        lastSyncedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(threads.id, storedThread.id),
          eq(threads.tenantId, input.tenantId),
          eq(threads.mailboxId, input.mailboxId),
          eq(threads.providerThreadId, input.thread.providerThreadId),
        ),
      )
      .returning({ id: threads.id });
    if (markedComplete.length !== 1) throw new ManualGmailSyncError("SYNC_FAILED");

    return {
      threadCreated: insertedThread.length === 1,
      messagesCreated,
    };
  }

  async #upsertMessage(input: {
    tenantId: string;
    mailboxId: string;
    threadId: string;
    message: NormalizedMessage;
    now: Date;
  }): Promise<boolean> {
    const newMessageId = crypto.randomUUID();
    const contentExpired = input.message.contentRetainUntil.getTime() <= input.now.getTime();
    const values = {
      id: newMessageId,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      threadId: input.threadId,
      providerMessageId: input.message.providerMessageId,
      senderName: input.message.senderName,
      senderEmail: input.message.senderEmail,
      replyToEmail: input.message.replyToEmail,
      recipientsJson: JSON.stringify(input.message.recipients),
      copiedRecipientsJson: JSON.stringify(input.message.copiedRecipients),
      subject: input.message.subject,
      textBody: contentExpired ? REDACTED_EMAIL_CONTENT : input.message.textBody,
      snippet: contentExpired ? "" : input.message.snippet,
      labelsJson: JSON.stringify(input.message.labels),
      internetMessageId: input.message.internetMessageId,
      inReplyTo: input.message.inReplyTo,
      referencesJson: JSON.stringify(input.message.references),
      receivedAt: input.message.receivedAt,
      contentRetainUntil: input.message.contentRetainUntil,
      contentHash: input.message.contentHash,
      ingestionStatus: "received" as const,
      createdAt: input.now,
      updatedAt: input.now,
    };
    const inserted = await this.#db
      .insert(messages)
      .values(values)
      .onConflictDoNothing({
        target: [messages.tenantId, messages.mailboxId, messages.providerMessageId],
      })
      .returning({ id: messages.id });

    const [storedMessage] = await this.#db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.tenantId, input.tenantId),
          eq(messages.mailboxId, input.mailboxId),
          eq(messages.threadId, input.threadId),
          eq(messages.providerMessageId, input.message.providerMessageId),
        ),
      )
      .limit(1);
    if (!storedMessage) throw new ManualGmailSyncError("SYNC_FAILED");

    if (inserted.length === 0) {
      await this.#db
        .update(messages)
        .set({
          senderName: input.message.senderName,
          senderEmail: input.message.senderEmail,
          replyToEmail: input.message.replyToEmail,
          recipientsJson: values.recipientsJson,
          copiedRecipientsJson: values.copiedRecipientsJson,
          subject: input.message.subject,
          textBody: values.textBody,
          snippet: values.snippet,
          labelsJson: values.labelsJson,
          internetMessageId: input.message.internetMessageId,
          inReplyTo: input.message.inReplyTo,
          referencesJson: values.referencesJson,
          receivedAt: input.message.receivedAt,
          contentRetainUntil: input.message.contentRetainUntil,
          contentHash: input.message.contentHash,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(messages.id, storedMessage.id),
            eq(messages.tenantId, input.tenantId),
            eq(messages.mailboxId, input.mailboxId),
            eq(messages.threadId, input.threadId),
          ),
        );
    }

    for (const attachment of input.message.attachments) {
      await this.#db
        .insert(attachments)
        .values({
          id: crypto.randomUUID(),
          tenantId: input.tenantId,
          messageId: storedMessage.id,
          providerAttachmentId: attachment.providerAttachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          riskLevel: "review",
          extractionStatus: "not_requested",
          objectReference: undefined,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            attachments.tenantId,
            attachments.messageId,
            attachments.providerAttachmentId,
          ],
          set: {
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            riskLevel: "review",
            extractionStatus: "not_requested",
            objectReference: undefined,
            updatedAt: input.now,
          },
        });
    }

    return inserted.length === 1;
  }

  async completeSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    importedThreads: number;
    importedMessages: number;
    providerHistoryId?: string;
    now: Date;
  }): Promise<void> {
    const updated = await this.#db
      .update(syncRuns)
      .set({
        status: "succeeded",
        importedThreads: input.importedThreads,
        importedMessages: input.importedMessages,
        providerHistoryId: input.providerHistoryId,
        errorCode: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(syncRuns.id, input.runId),
          eq(syncRuns.tenantId, input.tenantId),
          eq(syncRuns.mailboxId, input.mailboxId),
          eq(syncRuns.status, "running"),
        ),
      )
      .returning({ id: syncRuns.id });
    if (updated.length !== 1) throw new ManualGmailSyncError("SYNC_FAILED");

    await this.#db
      .update(mailboxes)
      .set({
        lastSuccessfulSyncAt: input.now,
        ...(input.providerHistoryId ? { lastHistoryId: input.providerHistoryId } : {}),
        connectionErrorCode: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(mailboxes.id, input.mailboxId),
          eq(mailboxes.tenantId, input.tenantId),
          eq(mailboxes.provider, "gmail"),
          eq(mailboxes.status, "active"),
        ),
      );
  }

  async failSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    errorCode: string;
    now: Date;
  }): Promise<void> {
    await this.#db
      .update(syncRuns)
      .set({
        status: "failed",
        errorCode: input.errorCode,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(syncRuns.id, input.runId),
          eq(syncRuns.tenantId, input.tenantId),
          eq(syncRuns.mailboxId, input.mailboxId),
          eq(syncRuns.status, "running"),
        ),
      );
    await this.#db
      .update(mailboxes)
      .set({ connectionErrorCode: input.errorCode, updatedAt: input.now })
      .where(
        and(
          eq(mailboxes.id, input.mailboxId),
          eq(mailboxes.tenantId, input.tenantId),
          eq(mailboxes.provider, "gmail"),
        ),
      );
  }

  async audit(input: GmailSyncAuditInput): Promise<void> {
    const result = input.phase === "failed"
      ? "failure"
      : input.phase === "started"
        ? "pending"
        : "success";
    await appendAuditEvent(
      {
        tenantId: input.tenantId,
        actorType: "user",
        actorId: input.actorId,
        eventType: `gmail.sync.${input.phase}`,
        action: "manual_gmail_sync",
        targetType: "sync_run",
        targetId: input.runId,
        result,
        status: input.phase,
        integrationResult: input.errorCode ?? input.phase,
        idempotencyKey: `gmail-sync:${input.runId}:${input.phase}`,
        metadata: {
          mailboxId: input.mailboxId,
          importedThreads: input.importedThreads ?? 0,
          importedMessages: input.importedMessages ?? 0,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
        },
      },
      this.#db,
    );
  }
}

function tokenAad(target: GmailSyncTarget, field: "access_token" | "refresh_token"): string {
  return buildSecretAad({
    tenantId: target.tenantId,
    resourceType: "mailbox_credential",
    resourceId: target.credentialId,
    field,
  });
}

async function resolveAccessToken(input: {
  target: GmailSyncTarget;
  environment: AppEnvironment;
  db: Database;
  now: Date;
  fetch?: FetchImplementation;
}): Promise<string> {
  const encryptionKey = input.environment.APP_ENCRYPTION_KEY;
  if (!encryptionKey) throw new ManualGmailSyncError("FEATURE_DISABLED", { status: 503 });

  let accessToken: string;
  try {
    accessToken = await decryptSecret(
      input.target.accessTokenEncrypted,
      encryptionKey,
      tokenAad(input.target, "access_token"),
    );
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw new ManualGmailSyncError("MAILBOX_REAUTH_REQUIRED", { status: 409 });
    }
    throw error;
  }

  if (input.target.tokenExpiresAt.getTime() > input.now.getTime() + 60_000) {
    return accessToken;
  }
  if (!input.target.refreshTokenEncrypted) {
    throw new ManualGmailSyncError("MAILBOX_REAUTH_REQUIRED", { status: 409 });
  }

  let refreshToken: string;
  try {
    refreshToken = await decryptSecret(
      input.target.refreshTokenEncrypted,
      encryptionKey,
      tokenAad(input.target, "refresh_token"),
    );
  } catch (error) {
    if (error instanceof SecretDecryptionError) {
      throw new ManualGmailSyncError("MAILBOX_REAUTH_REQUIRED", { status: 409 });
    }
    throw error;
  }

  const clientId = input.environment.GOOGLE_CLIENT_ID;
  const clientSecret = input.environment.GOOGLE_CLIENT_SECRET;
  const redirectUri = input.environment.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new ManualGmailSyncError("FEATURE_DISABLED", { status: 503 });
  }

  const rotated = await refreshGoogleAccessToken({
    client: { clientId, clientSecret, redirectUri },
    refreshToken,
    fetch: input.fetch,
    now: input.now.getTime(),
  });
  const accessTokenEncrypted = await encryptSecret(
    rotated.accessToken,
    encryptionKey,
    tokenAad(input.target, "access_token"),
  );
  const refreshTokenEncrypted = rotated.refreshToken
    ? await encryptSecret(
        rotated.refreshToken,
        encryptionKey,
        tokenAad(input.target, "refresh_token"),
      )
    : input.target.refreshTokenEncrypted;

  const updated = await input.db
    .update(mailboxCredentials)
    .set({
      accessTokenEncrypted,
      refreshTokenEncrypted,
      tokenExpiresAt: new Date(rotated.expiresAt),
      updatedAt: input.now,
    })
    .where(
      and(
        eq(mailboxCredentials.id, input.target.credentialId),
        eq(mailboxCredentials.tenantId, input.target.tenantId),
        eq(mailboxCredentials.mailboxId, input.target.mailboxId),
      ),
    )
    .returning({ id: mailboxCredentials.id });
  if (updated.length !== 1) throw new ManualGmailSyncError("MAILBOX_UNAVAILABLE", { status: 404 });

  await input.db
    .update(mailboxes)
    .set({ tokenExpiresAt: new Date(rotated.expiresAt), updatedAt: input.now })
    .where(
      and(
        eq(mailboxes.id, input.target.mailboxId),
        eq(mailboxes.tenantId, input.target.tenantId),
        eq(mailboxes.provider, "gmail"),
        eq(mailboxes.status, "active"),
      ),
    );

  accessToken = rotated.accessToken;
  return accessToken;
}

export async function executeD1ManualGmailSync(input: {
  environment: AppEnvironment;
  tenantId: string;
  mailboxId: string;
  actorId: string;
  idempotencyKey: string;
  signal?: AbortSignal;
  db?: Database;
  fetch?: FetchImplementation;
  now?: () => Date;
}): Promise<ManualGmailSyncResult> {
  const db = input.db ?? getDb();
  const repository = new D1GmailSyncRepository(db);
  return executeManualGmailSync(
    {
      enabled: input.environment.GMAIL_INTEGRATION_ENABLED,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      signal: input.signal,
    },
    {
      repository,
      now: input.now,
      createProvider: async (target) => {
        const now = input.now?.() ?? new Date();
        const accessToken = await resolveAccessToken({
          target,
          environment: input.environment,
          db,
          now,
          fetch: input.fetch,
        });
        return new GmailClient({
          accessToken,
          fetch: input.fetch,
        });
      },
    },
  );
}
