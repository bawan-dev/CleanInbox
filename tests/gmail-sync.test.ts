import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import type { GmailThread } from "../lib/gmail";
import {
  executeManualGmailSync,
  ManualGmailSyncError,
} from "../lib/sync/core";
import { normalizeFullGmailThread } from "../lib/sync/parser";
import type {
  BeginSyncRunResult,
  GmailSyncAuditInput,
  GmailSyncRepository,
  GmailSyncTarget,
  NormalizedThread,
  SyncRunRecord,
  ThreadUpsertResult,
} from "../lib/sync/types";

const fixedNow = new Date("2026-08-06T12:00:00.000Z");

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function gmailFixture(): GmailThread {
  return {
    id: "thread_1",
    historyId: "901",
    messages: [
      {
        id: "message_1",
        threadId: "thread_1",
        internalDate: String(Date.parse("2026-08-06T10:00:00.000Z")),
        labelIds: ["INBOX", "IMPORTANT"],
        snippet: "A safe first-message snippet",
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: "Customer One <customer@example.net>" },
            { name: "Reply-To", value: "support-contact@example.net" },
            { name: "To", value: "Inbox <team@example.com>" },
            { name: "Cc", value: "Reviewer <reviewer@example.com>" },
            { name: "Subject", value: "Account question" },
            { name: "Message-ID", value: "<message-1@example.net>" },
          ],
          parts: [
            {
              partId: "0.0",
              mimeType: "multipart/alternative",
              parts: [
                {
                  partId: "0.0.0",
                  mimeType: "text/html",
                  body: { data: encoded("<p>HTML_SHOULD_NOT_BE_STORED</p>") },
                },
                {
                  partId: "0.0.1",
                  mimeType: "text/plain",
                  body: { data: encoded("Plain text accepted.\r\nSecond line.") },
                },
              ],
            },
            {
              partId: "0.1",
              mimeType: "application/pdf",
              filename: "invoice.pdf",
              headers: [{ name: "Content-Disposition", value: "attachment" }],
              body: {
                attachmentId: "attachment_1",
                data: encoded("ATTACHMENT_BYTES_SHOULD_NOT_BE_STORED"),
                size: 4_096,
              },
            },
          ],
        },
      },
      {
        id: "message_2",
        threadId: "thread_1",
        internalDate: String(Date.parse("2026-08-06T11:00:00.000Z")),
        labelIds: ["INBOX"],
        snippet: "The second message",
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "team@example.com" },
            { name: "To", value: "customer@example.net" },
            { name: "Subject", value: "Re: Account question" },
            { name: "Message-ID", value: "<message-2@example.com>" },
            { name: "In-Reply-To", value: "<message-1@example.net>" },
            { name: "References", value: "<message-1@example.net>" },
          ],
          body: { data: encoded("A complete second message.") },
        },
      },
    ],
  };
}

class MemorySyncRepository implements GmailSyncRepository {
  readonly target: GmailSyncTarget = {
    tenantId: "tenant-a",
    mailboxId: "mailbox-a",
    providerMailboxId: "me@example.com",
    credentialId: "credential-a",
    accessTokenEncrypted: "not-used-by-test-provider",
    tokenExpiresAt: new Date("2026-08-06T14:00:00.000Z"),
    initialSyncLimit: 999,
    contentRetentionDays: 30,
  };

  readonly runs = new Map<string, SyncRunRecord>();
  readonly threadIds = new Set<string>();
  readonly messageIds = new Set<string>();
  readonly storedThreads: NormalizedThread[] = [];
  readonly audits: GmailSyncAuditInput[] = [];

  async findSyncTarget(tenantId: string, mailboxId: string) {
    return tenantId === this.target.tenantId && mailboxId === this.target.mailboxId
      ? this.target
      : undefined;
  }

  async beginSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    actorId: string;
    idempotencyKey: string;
    now: Date;
  }): Promise<BeginSyncRunResult> {
    const key = `${input.tenantId}:${input.idempotencyKey}`;
    const existing = this.runs.get(key);
    if (existing) return { created: false, run: existing };
    const run: SyncRunRecord = {
      id: `run-${this.runs.size + 1}`,
      tenantId: input.tenantId,
      mailboxId: input.mailboxId,
      idempotencyKey: input.idempotencyKey,
      status: "running",
      importedMessages: 0,
      importedThreads: 0,
    };
    this.runs.set(key, run);
    return { created: true, run };
  }

  async upsertThread(input: {
    tenantId: string;
    mailboxId: string;
    thread: NormalizedThread;
    now: Date;
  }): Promise<ThreadUpsertResult> {
    assert.equal(input.tenantId, "tenant-a");
    assert.equal(input.mailboxId, "mailbox-a");
    const threadCreated = !this.threadIds.has(input.thread.providerThreadId);
    this.threadIds.add(input.thread.providerThreadId);
    let messagesCreated = 0;
    for (const message of input.thread.messages) {
      if (!this.messageIds.has(message.providerMessageId)) messagesCreated += 1;
      this.messageIds.add(message.providerMessageId);
    }
    this.storedThreads.push(input.thread);
    return { threadCreated, messagesCreated };
  }

  async completeSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    importedThreads: number;
    importedMessages: number;
    providerHistoryId?: string;
    now: Date;
  }) {
    const run = [...this.runs.values()].find((candidate) => candidate.id === input.runId);
    assert.ok(run);
    run.status = "succeeded";
    run.importedThreads = input.importedThreads;
    run.importedMessages = input.importedMessages;
  }

  async failSyncRun(input: {
    tenantId: string;
    mailboxId: string;
    runId: string;
    errorCode: string;
    now: Date;
  }) {
    const run = [...this.runs.values()].find((candidate) => candidate.id === input.runId);
    assert.ok(run);
    run.status = "failed";
    run.errorCode = input.errorCode;
  }

  async audit(input: GmailSyncAuditInput) {
    this.audits.push(input);
  }
}

test("normalization keeps text/plain and attachment metadata but never HTML or attachment bytes", async () => {
  const normalized = await normalizeFullGmailThread(gmailFixture(), {
    now: fixedNow,
    retentionDays: 30,
  });

  assert.equal(normalized.messages.length, 2);
  assert.equal(normalized.messages[0].textBody, "Plain text accepted.\nSecond line.");
  assert.deepEqual(normalized.messages[0].attachments, [
    {
      providerAttachmentId: "attachment_1",
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4_096,
    },
  ]);
  assert.deepEqual(normalized.messages[0].recipients, ["team@example.com"]);
  assert.deepEqual(normalized.messages[0].copiedRecipients, ["reviewer@example.com"]);
  assert.equal(normalized.messages[0].contentRetainUntil.toISOString(), "2026-09-05T10:00:00.000Z");

  const persistedShape = JSON.stringify(normalized);
  assert.equal(persistedShape.includes("HTML_SHOULD_NOT_BE_STORED"), false);
  assert.equal(persistedShape.includes("ATTACHMENT_BYTES_SHOULD_NOT_BE_STORED"), false);
  assert.equal(persistedShape.includes("data"), false);
});

test("normalization rejects list stubs and cross-thread messages as incomplete", async () => {
  await assert.rejects(
    normalizeFullGmailThread({ id: "thread_1" }, { now: fixedNow, retentionDays: 30 }),
    (error: unknown) => (error as { code?: string }).code === "GMAIL_PAYLOAD_INVALID",
  );

  const mismatched = gmailFixture();
  assert.ok(mismatched.messages?.[0]);
  mismatched.messages[0].threadId = "thread_other";
  await assert.rejects(
    normalizeFullGmailThread(mismatched, { now: fixedNow, retentionDays: 30 }),
    (error: unknown) => (error as { code?: string }).code === "GMAIL_PAYLOAD_INVALID",
  );
});

test("manual sync fetches complete threads, caps the limit, and deduplicates repeat imports", async () => {
  const repository = new MemorySyncRepository();
  const requestedLimits: number[] = [];
  let fullThreadReads = 0;
  const createProvider = async () => ({
    listRecentInboxThreads: async (options: { maxResults: number }) => {
      requestedLimits.push(options.maxResults);
      return { threads: [{ id: "thread_1", historyId: "900" }] };
    },
    getFullThread: async () => {
      fullThreadReads += 1;
      return gmailFixture();
    },
  });

  const first = await executeManualGmailSync(
    {
      enabled: true,
      tenantId: "tenant-a",
      mailboxId: "mailbox-a",
      actorId: "user-a",
      idempotencyKey: "sync-key-0001",
    },
    { repository, createProvider, now: () => fixedNow },
  );
  assert.deepEqual(first, {
    runId: "run-1",
    status: "succeeded",
    replayed: false,
    importedThreads: 1,
    importedMessages: 2,
  });
  assert.equal(repository.storedThreads[0].messages.length, 2);

  const second = await executeManualGmailSync(
    {
      enabled: true,
      tenantId: "tenant-a",
      mailboxId: "mailbox-a",
      actorId: "user-a",
      idempotencyKey: "sync-key-0002",
    },
    { repository, createProvider, now: () => fixedNow },
  );
  assert.equal(second.importedThreads, 0);
  assert.equal(second.importedMessages, 0);
  assert.deepEqual(requestedLimits, [100, 100]);
  assert.equal(fullThreadReads, 2);

  const replay = await executeManualGmailSync(
    {
      enabled: true,
      tenantId: "tenant-a",
      mailboxId: "mailbox-a",
      actorId: "user-a",
      idempotencyKey: "sync-key-0002",
    },
    { repository, createProvider, now: () => fixedNow },
  );
  assert.equal(replay.replayed, true);
  assert.equal(fullThreadReads, 2);
  assert.deepEqual(repository.audits.map((event) => event.phase), [
    "started",
    "completed",
    "started",
    "completed",
  ]);
});

test("tenant-scoped mailbox lookup blocks cross-tenant sync before any provider call", async () => {
  const repository = new MemorySyncRepository();
  let providerCalls = 0;

  await assert.rejects(
    executeManualGmailSync(
      {
        enabled: true,
        tenantId: "tenant-b",
        mailboxId: "mailbox-a",
        actorId: "user-b",
        idempotencyKey: "sync-key-cross-tenant",
      },
      {
        repository,
        createProvider: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ManualGmailSyncError);
      assert.equal(error.code, "MAILBOX_UNAVAILABLE");
      assert.equal(error.status, 404);
      return true;
    },
  );
  assert.equal(providerCalls, 0);
  assert.equal(repository.runs.size, 0);
});

test("disabled Gmail integration fails closed before mailbox or provider access", async () => {
  const repository = new MemorySyncRepository();
  let providerCalls = 0;
  await assert.rejects(
    executeManualGmailSync(
      {
        enabled: false,
        tenantId: "tenant-a",
        mailboxId: "mailbox-a",
        actorId: "user-a",
        idempotencyKey: "sync-key-disabled",
      },
      {
        repository,
        createProvider: async () => {
          providerCalls += 1;
          throw new Error("must not run");
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ManualGmailSyncError);
      assert.equal(error.code, "FEATURE_DISABLED");
      return true;
    },
  );
  assert.equal(providerCalls, 0);
  assert.equal(repository.runs.size, 0);
});
