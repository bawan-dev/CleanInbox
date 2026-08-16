import assert from "node:assert/strict";
import test from "node:test";
import {
  DraftWorkflowError,
  executeApprovedDraftWorkflow,
  type ApprovedDraftSnapshot,
  type DraftExecutionDependencies,
  type DraftExecutionRecord,
  type DraftProvider,
} from "../lib/drafts/gmail-execution";
import {
  calculateApprovalActionHash,
  calculateDraftContentHash,
  type ApprovedDraftIdentity,
} from "../lib/drafts/integrity";
import { GmailApiError } from "../lib/gmail";

const NOW = new Date("2026-08-06T20:00:00.000Z");

async function makeSnapshot(
  overrides: Partial<ApprovedDraftSnapshot> = {},
): Promise<ApprovedDraftSnapshot> {
  const content = {
    recipients: ["customer@example.com"],
    subject: "Re: Support request",
    body: "We can help with that.",
  };
  const contentHash = await calculateDraftContentHash(content);
  const identity: ApprovedDraftIdentity = {
    tenantId: "tenant-a",
    mailboxId: "mailbox-a",
    messageId: "message-a",
    threadId: "thread-a",
    draftId: "draft-a",
    draftVersionId: "draft-version-a",
    draftVersion: 2,
    contentHash,
  };
  const snapshot: ApprovedDraftSnapshot = {
    tenantId: identity.tenantId,
    draftId: identity.draftId,
    draftStatus: "approved",
    draftCurrentVersion: identity.draftVersion,
    draftVersionId: identity.draftVersionId,
    draftVersion: identity.draftVersion,
    recipientsJson: JSON.stringify(content.recipients),
    subject: content.subject,
    body: content.body,
    storedContentHash: contentHash,
    messageId: identity.messageId,
    sourceInternetMessageId: "<source-message@example.com>",
    sourceReferencesJson: JSON.stringify(["<older-message@example.com>"]),
    threadId: identity.threadId,
    providerThreadId: "provider-thread-a",
    mailboxId: identity.mailboxId,
    mailboxAddress: "support@example.com",
    mailboxDisplayName: "Support",
    mailboxProvider: "gmail",
    mailboxStatus: "active",
    approvalId: "approval-a",
    approvalStatus: "approved",
    approvalDraftVersionId: identity.draftVersionId,
    approvalDraftVersion: identity.draftVersion,
    approvalContentHash: contentHash,
    approvalActionHash: await calculateApprovalActionHash(identity),
    approvalExpiresAt: new Date(NOW.getTime() + 30 * 60_000),
    approvalRevokedAt: null,
  };
  return { ...snapshot, ...overrides };
}

type Harness = {
  dependencies: DraftExecutionDependencies;
  provider: DraftProvider;
  getRecord(): DraftExecutionRecord | undefined;
  getCreateCalls(): number;
  getListCalls(): number;
  audits: Array<{ event: string; errorCode?: string }>;
  setListResult(value: Awaited<ReturnType<DraftProvider["listDraftsByRfcMessageId"]>>): void;
};

function makeHarness(options: {
  snapshot: ApprovedDraftSnapshot;
  create?: DraftProvider["createDraft"];
  listResult?: Awaited<ReturnType<DraftProvider["listDraftsByRfcMessageId"]>>;
}): Harness {
  let record: DraftExecutionRecord | undefined;
  let createCalls = 0;
  let listCalls = 0;
  let listResult = options.listResult ?? { drafts: [] };
  const audits: Array<{ event: string; errorCode?: string }> = [];

  const provider: DraftProvider = {
    async createDraft(input) {
      createCalls += 1;
      if (options.create) return options.create(input);
      return {
        id: "gmail-draft-a",
        message: { id: "gmail-message-a", threadId: options.snapshot.providerThreadId },
      };
    },
    async listDraftsByRfcMessageId() {
      listCalls += 1;
      return listResult;
    },
  };

  const dependencies: DraftExecutionDependencies = {
    now: () => new Date(NOW),
    loadApprovedSnapshot: async () => ({ ...options.snapshot }),
    async claimExecution(input) {
      if (record) return { record: { ...record }, created: false };
      record = {
        id: "execution-a",
        tenantId: input.identity.tenantId,
        idempotencyKey: input.idempotencyKey,
        status: "proposed",
        providerDraftId: null,
        providerMessageId: null,
        providerThreadId: null,
        rfcMessageId: input.rfcMessageId,
      };
      return { record: { ...record }, created: true };
    },
    async transitionToAttempting(_tenantId, _executionId, allowedStatuses) {
      if (!record || !allowedStatuses.includes(record.status)) return false;
      record.status = "attempting";
      return true;
    },
    async markSucceeded(_tenantId, _executionId, _draftId, result) {
      assert.ok(record);
      record.status = "succeeded";
      record.providerDraftId = result.draftId;
      record.providerMessageId = result.messageId;
      record.providerThreadId = result.threadId;
      options.snapshot.draftStatus = "executed";
    },
    async markFailed(_tenantId, _executionId, status) {
      assert.ok(record);
      record.status = status;
    },
    createProvider: async () => provider,
    async audit(input) {
      audits.push({ event: input.event, errorCode: input.errorCode });
    },
  };

  return {
    dependencies,
    provider,
    getRecord: () => record,
    getCreateCalls: () => createCalls,
    getListCalls: () => listCalls,
    audits,
    setListResult(value) {
      listResult = value;
    },
  };
}

function executionInput(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-a",
    actorId: "user-a",
    draftId: "draft-a",
    correlationId: "correlation-a",
    requestId: "request-a",
    ...overrides,
  };
}

test("Gmail draft creation rejects a missing exact-version approval", async () => {
  const snapshot = await makeSnapshot({
    approvalId: null,
    approvalStatus: null,
    approvalDraftVersionId: null,
    approvalDraftVersion: null,
    approvalContentHash: null,
    approvalActionHash: null,
    approvalExpiresAt: null,
  });
  const harness = makeHarness({ snapshot });

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError && error.code === "EXACT_APPROVAL_REQUIRED",
  );
  assert.equal(harness.getCreateCalls(), 0);
});

test("Gmail draft creation rejects stale edited content and an approval hash mismatch", async () => {
  const snapshot = await makeSnapshot({ body: "Changed after approval." });
  const harness = makeHarness({ snapshot });

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError && error.code === "DRAFT_HASH_MISMATCH",
  );
  assert.equal(harness.getCreateCalls(), 0);
});

test("an edit racing after the execution claim is caught by the immediate pre-call reload", async () => {
  const snapshot = await makeSnapshot();
  const harness = makeHarness({ snapshot });
  let loadCount = 0;
  harness.dependencies.loadApprovedSnapshot = async () => {
    loadCount += 1;
    return loadCount === 1 ? { ...snapshot } : { ...snapshot, body: "Racing edit" };
  };

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError && error.code === "DRAFT_HASH_MISMATCH",
  );
  assert.equal(harness.getRecord()?.status, "failed");
  assert.equal(harness.getCreateCalls(), 0);
});

test("tenant mismatch is hidden as not found before an execution is claimed", async () => {
  const snapshot = await makeSnapshot({ tenantId: "tenant-b" });
  const harness = makeHarness({ snapshot });

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError &&
      error.status === 404 &&
      error.code === "DRAFT_NOT_FOUND",
  );
  assert.equal(harness.getRecord(), undefined);
});

test("double-click and later replay return the original verified Gmail draft", async () => {
  const snapshot = await makeSnapshot();
  const harness = makeHarness({ snapshot });

  const first = await executeApprovedDraftWorkflow(executionInput(), harness.dependencies);
  const replay = await executeApprovedDraftWorkflow(
    executionInput({ requestId: "request-b" }),
    harness.dependencies,
  );

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.providerDraftId, first.providerDraftId);
  assert.equal(harness.getCreateCalls(), 1);
});

test("ambiguous provider result is reconciled by deterministic RFC Message-ID without another POST", async () => {
  const snapshot = await makeSnapshot();
  const harness = makeHarness({
    snapshot,
    async create() {
      throw new GmailApiError({
        code: "GMAIL_TIMEOUT",
        operation: "drafts.create",
        message: "Gmail request timed out",
      });
    },
  });

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError && error.code === "GMAIL_RESULT_AMBIGUOUS",
  );
  assert.equal(harness.getRecord()?.status, "ambiguous");

  await assert.rejects(
    executeApprovedDraftWorkflow(
      executionInput({ requestId: "request-b" }),
      harness.dependencies,
    ),
    (error: unknown) =>
      error instanceof DraftWorkflowError &&
      error.code === "AMBIGUOUS_RETRY_CONFIRMATION_REQUIRED",
  );
  assert.equal(harness.getCreateCalls(), 1);

  harness.setListResult({
    drafts: [
      {
        id: "gmail-draft-reconciled",
        message: { id: "gmail-message-reconciled", threadId: snapshot.providerThreadId },
      },
    ],
  });
  const reconciled = await executeApprovedDraftWorkflow(
    executionInput({ requestId: "request-c" }),
    harness.dependencies,
  );

  assert.equal(reconciled.reconciled, true);
  assert.equal(reconciled.providerDraftId, "gmail-draft-reconciled");
  assert.equal(harness.getCreateCalls(), 1);
  assert.equal(harness.getListCalls(), 2);
});

test("definitive provider failure is recorded safely and is not retried in the same call", async () => {
  const snapshot = await makeSnapshot();
  const harness = makeHarness({
    snapshot,
    async create() {
      throw new GmailApiError({
        code: "GMAIL_HTTP_ERROR",
        operation: "drafts.create",
        status: 400,
        message: "Gmail returned HTTP 400",
      });
    },
  });

  await assert.rejects(
    executeApprovedDraftWorkflow(executionInput(), harness.dependencies),
    (error: unknown) =>
      error instanceof DraftWorkflowError &&
      error.status === 502 &&
      error.code === "GMAIL_DRAFT_CREATE_FAILED",
  );
  assert.equal(harness.getCreateCalls(), 1);
  assert.equal(harness.getRecord()?.status, "failed");
  assert.deepEqual(harness.audits.map((audit) => audit.event), ["attempted", "failed"]);
  assert.equal(harness.audits.at(-1)?.errorCode, "GMAIL_HTTP_ERROR");
});
