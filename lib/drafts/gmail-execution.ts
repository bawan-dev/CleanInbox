import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  actionExecutions,
  approvalRequests,
  draftVersions,
  drafts,
  mailboxCredentials,
  mailboxes,
  messages,
  threads,
} from "@/db/schema";
import {
  calculateApprovalActionHash,
  calculateDraftContentHash,
  calculateDraftCreationIdempotencyKey,
  createDeterministicRfcMessageId,
  type ApprovedDraftIdentity,
} from "@/lib/drafts/integrity";
import { GmailApiError, GmailClient, buildReplyMime, normalizeRfcMessageId } from "@/lib/gmail";
import { refreshGoogleAccessToken } from "@/lib/google/oauth";
import { buildSecretAad, decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { loadEnvironment } from "@/lib/security/env";

const executionStatusSchema = z.enum([
  "proposed",
  "attempting",
  "succeeded",
  "failed",
  "ambiguous",
  "cancelled",
]);
const recipientListSchema = z.array(z.email()).min(1).max(100);
const referencesSchema = z.array(z.string().min(3).max(254)).max(30);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,256}$/u;

export type DraftExecutionStatus = z.infer<typeof executionStatusSchema>;

export class DraftWorkflowError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 502 | 503;

  constructor(code: string, message: string, status: 400 | 404 | 409 | 502 | 503) {
    super(message);
    this.name = "DraftWorkflowError";
    this.code = code;
    this.status = status;
  }
}

export type ApprovedDraftSnapshot = {
  tenantId: string;
  draftId: string;
  draftStatus: string;
  draftCurrentVersion: number;
  draftVersionId: string;
  draftVersion: number;
  recipientsJson: string;
  subject: string;
  body: string;
  storedContentHash: string;
  messageId: string;
  sourceInternetMessageId: string | null;
  sourceReferencesJson: string;
  threadId: string;
  providerThreadId: string;
  mailboxId: string;
  mailboxAddress: string;
  mailboxDisplayName: string | null;
  mailboxProvider: string;
  mailboxStatus: string;
  approvalId: string | null;
  approvalStatus: string | null;
  approvalDraftVersionId: string | null;
  approvalDraftVersion: number | null;
  approvalContentHash: string | null;
  approvalActionHash: string | null;
  approvalExpiresAt: Date | null;
  approvalRevokedAt: Date | null;
};

export type DraftExecutionRecord = {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  status: DraftExecutionStatus;
  providerDraftId: string | null;
  providerMessageId: string | null;
  providerThreadId: string | null;
  rfcMessageId: string;
};

export type DraftProvider = {
  createDraft(input: { threadId: string; raw: string }): Promise<{
    id: string;
    message?: { id: string; threadId: string };
  }>;
  listDraftsByRfcMessageId(rfcMessageId: string): Promise<{
    drafts?: Array<{ id: string; message?: { id: string; threadId: string } }>;
  }>;
};

type ClaimInput = {
  identity: ApprovedDraftIdentity;
  approvalId: string;
  idempotencyKey: string;
  correlationId: string;
  rfcMessageId: string;
};

type ProviderResult = {
  draftId: string;
  messageId: string;
  threadId: string;
};

type SafeAuditInput = {
  event: "attempted" | "succeeded" | "failed";
  tenantId: string;
  actorId: string;
  executionId: string;
  messageId: string;
  threadId: string;
  approvalId: string;
  correlationId: string;
  requestId: string;
  idempotencyKey: string;
  result: "pending" | "success" | "failure";
  errorCode?: string;
  integrationResult?: string;
};

export type DraftExecutionDependencies = {
  now(): Date;
  loadApprovedSnapshot(tenantId: string, draftId: string): Promise<ApprovedDraftSnapshot>;
  claimExecution(input: ClaimInput): Promise<{ record: DraftExecutionRecord; created: boolean }>;
  transitionToAttempting(
    tenantId: string,
    executionId: string,
    allowedStatuses: DraftExecutionStatus[],
    attemptedAt: Date,
  ): Promise<boolean>;
  markSucceeded(
    tenantId: string,
    executionId: string,
    identity: ApprovedDraftIdentity,
    result: ProviderResult,
    completedAt: Date,
  ): Promise<void>;
  markFailed(
    tenantId: string,
    executionId: string,
    status: "failed" | "ambiguous",
    errorCode: string,
    completedAt: Date,
  ): Promise<void>;
  createProvider(snapshot: ApprovedDraftSnapshot): Promise<DraftProvider>;
  audit(input: SafeAuditInput): Promise<void>;
};

export type ExecuteApprovedDraftInput = {
  tenantId: string;
  actorId: string;
  draftId: string;
  correlationId: string;
  requestId: string;
  retryAfterReconciliation?: boolean;
};

export type ExecuteApprovedDraftResult = {
  executionId: string;
  status: "succeeded";
  providerDraftId: string;
  providerMessageId: string;
  providerThreadId: string;
  replayed: boolean;
  reconciled: boolean;
};

type ValidatedSnapshot = {
  snapshot: ApprovedDraftSnapshot;
  identity: ApprovedDraftIdentity;
  approvalId: string;
  recipients: string[];
  references: string[];
};

function parseStoredJson<T>(raw: string, schema: z.ZodType<T>, field: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DraftWorkflowError(
      "DRAFT_DATA_INVALID",
      `Stored draft ${field} failed integrity validation.`,
      409,
    );
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new DraftWorkflowError(
      "DRAFT_DATA_INVALID",
      `Stored draft ${field} failed integrity validation.`,
      409,
    );
  }
  return parsed.data;
}

async function validateSnapshot(
  snapshot: ApprovedDraftSnapshot,
  expectedTenantId: string,
  expectedDraftId: string,
  now: Date,
  requireActiveApproval = true,
): Promise<ValidatedSnapshot> {
  if (snapshot.tenantId !== expectedTenantId || snapshot.draftId !== expectedDraftId) {
    throw new DraftWorkflowError(
      "DRAFT_NOT_FOUND",
      "Draft was not found in this organisation.",
      404,
    );
  }
  if (snapshot.mailboxProvider !== "gmail" || snapshot.mailboxStatus !== "active") {
    throw new DraftWorkflowError(
      "GMAIL_MAILBOX_UNAVAILABLE",
      "The Gmail mailbox is not connected and active.",
      409,
    );
  }
  if (
    snapshot.draftVersion !== snapshot.draftCurrentVersion ||
    !snapshot.approvalId ||
    snapshot.approvalDraftVersionId !== snapshot.draftVersionId ||
    snapshot.approvalDraftVersion !== snapshot.draftVersion ||
    !snapshot.approvalExpiresAt
  ) {
    throw new DraftWorkflowError(
      "EXACT_APPROVAL_REQUIRED",
      "An approval record for the exact current draft version is required.",
      409,
    );
  }
  if (
    requireActiveApproval &&
    (snapshot.draftStatus !== "approved" ||
      snapshot.approvalStatus !== "approved" ||
      snapshot.approvalExpiresAt.getTime() <= now.getTime() ||
      snapshot.approvalRevokedAt !== null)
  ) {
    throw new DraftWorkflowError(
      "EXACT_APPROVAL_REQUIRED",
      "An active approval for the exact current draft version is required.",
      409,
    );
  }

  const recipients = parseStoredJson(snapshot.recipientsJson, recipientListSchema, "recipients");
  const references = parseStoredJson(snapshot.sourceReferencesJson, referencesSchema, "references");
  const recalculatedHash = await calculateDraftContentHash({
    recipients,
    subject: snapshot.subject,
    body: snapshot.body,
  });
  if (
    recalculatedHash !== snapshot.storedContentHash ||
    recalculatedHash !== snapshot.approvalContentHash
  ) {
    throw new DraftWorkflowError(
      "DRAFT_HASH_MISMATCH",
      "The approved draft content no longer matches the current stored version.",
      409,
    );
  }

  const identity: ApprovedDraftIdentity = {
    tenantId: snapshot.tenantId,
    mailboxId: snapshot.mailboxId,
    messageId: snapshot.messageId,
    threadId: snapshot.threadId,
    draftId: snapshot.draftId,
    draftVersionId: snapshot.draftVersionId,
    draftVersion: snapshot.draftVersion,
    contentHash: recalculatedHash,
  };
  const expectedActionHash = await calculateApprovalActionHash(identity);
  if (expectedActionHash !== snapshot.approvalActionHash) {
    throw new DraftWorkflowError(
      "APPROVAL_HASH_MISMATCH",
      "The approval does not authorize this exact Gmail draft action.",
      409,
    );
  }

  if (!snapshot.sourceInternetMessageId) {
    throw new DraftWorkflowError(
      "THREADING_HEADERS_UNAVAILABLE",
      "The source message is missing the threading header required to create a safe reply draft.",
      409,
    );
  }
  try {
    normalizeRfcMessageId(snapshot.sourceInternetMessageId, "Source Message-ID");
    references.forEach((reference) => normalizeRfcMessageId(reference, "Source References"));
  } catch {
    throw new DraftWorkflowError(
      "THREADING_HEADERS_INVALID",
      "The source message has invalid threading headers.",
      409,
    );
  }

  return { snapshot, identity, approvalId: snapshot.approvalId, recipients, references };
}

function validateProviderResult(
  value: { id?: unknown; message?: { id?: unknown; threadId?: unknown } },
  expectedThreadId: string,
): ProviderResult | null {
  if (
    typeof value.id !== "string" ||
    !PROVIDER_ID_PATTERN.test(value.id) ||
    typeof value.message?.id !== "string" ||
    !PROVIDER_ID_PATTERN.test(value.message.id) ||
    typeof value.message.threadId !== "string" ||
    value.message.threadId !== expectedThreadId ||
    !PROVIDER_ID_PATTERN.test(value.message.threadId)
  ) {
    return null;
  }
  return { draftId: value.id, messageId: value.message.id, threadId: value.message.threadId };
}

function successfulReplay(record: DraftExecutionRecord): ExecuteApprovedDraftResult {
  if (!record.providerDraftId || !record.providerMessageId || !record.providerThreadId) {
    throw new DraftWorkflowError(
      "EXECUTION_RECORD_INVALID",
      "The prior Gmail draft result could not be verified.",
      409,
    );
  }
  return {
    executionId: record.id,
    status: "succeeded",
    providerDraftId: record.providerDraftId,
    providerMessageId: record.providerMessageId,
    providerThreadId: record.providerThreadId,
    replayed: true,
    reconciled: false,
  };
}

function isAmbiguousProviderError(error: unknown): boolean {
  if (!(error instanceof GmailApiError)) return true;
  if (error.code === "GMAIL_VALIDATION_ERROR") return false;
  if (error.code === "GMAIL_HTTP_ERROR" && error.status && error.status < 500) return false;
  return true;
}

async function reconcileExecution(
  provider: DraftProvider,
  record: DraftExecutionRecord,
  validated: ValidatedSnapshot,
  input: ExecuteApprovedDraftInput,
  dependencies: DraftExecutionDependencies,
): Promise<ExecuteApprovedDraftResult | null> {
  let listed: Awaited<ReturnType<DraftProvider["listDraftsByRfcMessageId"]>>;
  try {
    listed = await provider.listDraftsByRfcMessageId(record.rfcMessageId);
  } catch {
    throw new DraftWorkflowError(
      "GMAIL_RECONCILIATION_UNAVAILABLE",
      "Gmail draft reconciliation is temporarily unavailable; no create request was retried.",
      503,
    );
  }

  const match = listed.drafts
    ?.map((draft) => validateProviderResult(draft, validated.snapshot.providerThreadId))
    .find((draft): draft is ProviderResult => draft !== null);
  if (!match) return null;

  const completedAt = dependencies.now();
  await dependencies.markSucceeded(
    input.tenantId,
    record.id,
    validated.identity,
    match,
    completedAt,
  );
  await dependencies.audit({
    event: "succeeded",
    tenantId: input.tenantId,
    actorId: input.actorId,
    executionId: record.id,
    messageId: validated.snapshot.messageId,
    threadId: validated.snapshot.threadId,
    approvalId: validated.approvalId,
    correlationId: input.correlationId,
    requestId: input.requestId,
    idempotencyKey: record.idempotencyKey,
    result: "success",
    integrationResult: "reconciled_existing_gmail_draft",
  });

  return {
    executionId: record.id,
    status: "succeeded",
    providerDraftId: match.draftId,
    providerMessageId: match.messageId,
    providerThreadId: match.threadId,
    replayed: true,
    reconciled: true,
  };
}

/**
 * Orchestrates the exact-version gate. POSTing to Gmail occurs at most once per
 * invocation. An ambiguous prior attempt is searched by deterministic Message-ID
 * and requires an explicit retryAfterReconciliation flag before another POST.
 */
export async function executeApprovedDraftWorkflow(
  input: ExecuteApprovedDraftInput,
  dependencies: DraftExecutionDependencies,
): Promise<ExecuteApprovedDraftResult> {
  const initial = await validateSnapshot(
    await dependencies.loadApprovedSnapshot(input.tenantId, input.draftId),
    input.tenantId,
    input.draftId,
    dependencies.now(),
    false,
  );
  const idempotencyKey = await calculateDraftCreationIdempotencyKey(initial.identity);
  const rfcMessageId = await createDeterministicRfcMessageId(initial.identity);
  const claimed = await dependencies.claimExecution({
    identity: initial.identity,
    approvalId: initial.approvalId,
    idempotencyKey,
    correlationId: input.correlationId,
    rfcMessageId,
  });
  const record = claimed.record;

  if (record.status === "succeeded") return successfulReplay(record);

  // A replay may remain available after approval expiry, but a new provider
  // attempt always requires the approval to be active at the time of execution.
  await validateSnapshot(
    initial.snapshot,
    input.tenantId,
    input.draftId,
    dependencies.now(),
    true,
  );

  if (!claimed.created && (record.status === "attempting" || record.status === "ambiguous")) {
    const provider = await dependencies.createProvider(initial.snapshot);
    const reconciled = await reconcileExecution(provider, record, initial, input, dependencies);
    if (reconciled) return reconciled;

    if (record.status === "attempting") {
      throw new DraftWorkflowError(
        "EXECUTION_IN_PROGRESS",
        "Gmail draft creation is already in progress; no duplicate create request was made.",
        409,
      );
    }
    if (!input.retryAfterReconciliation) {
      throw new DraftWorkflowError(
        "AMBIGUOUS_RETRY_CONFIRMATION_REQUIRED",
        "The prior result is ambiguous and no matching Gmail draft was found. Confirm a deliberate retry to continue.",
        409,
      );
    }
  }

  if (record.status === "cancelled") {
    throw new DraftWorkflowError(
      "EXECUTION_CANCELLED",
      "This Gmail draft action was cancelled and cannot be retried.",
      409,
    );
  }

  const transitioned = await dependencies.transitionToAttempting(
    input.tenantId,
    record.id,
    claimed.created
      ? ["proposed"]
      : record.status === "ambiguous"
        ? ["ambiguous"]
        : ["failed", "proposed"],
    dependencies.now(),
  );
  if (!transitioned) {
    throw new DraftWorkflowError(
      "EXECUTION_IN_PROGRESS",
      "Gmail draft creation is already in progress; no duplicate create request was made.",
      409,
    );
  }

  // Reload and recalculate after claiming, immediately before constructing MIME.
  let current: ValidatedSnapshot;
  try {
    current = await validateSnapshot(
      await dependencies.loadApprovedSnapshot(input.tenantId, input.draftId),
      input.tenantId,
      input.draftId,
      dependencies.now(),
    );
  } catch (error) {
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      "PRE_EXECUTION_VALIDATION_FAILED",
      dependencies.now(),
    );
    if (error instanceof DraftWorkflowError) throw error;
    throw new DraftWorkflowError(
      "PRE_EXECUTION_VALIDATION_FAILED",
      "The draft could not be validated immediately before execution.",
      409,
    );
  }
  if (
    current.identity.draftVersionId !== initial.identity.draftVersionId ||
    current.identity.contentHash !== initial.identity.contentHash
  ) {
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      "DRAFT_CHANGED_BEFORE_EXECUTION",
      dependencies.now(),
    );
    throw new DraftWorkflowError(
      "DRAFT_CHANGED_BEFORE_EXECUTION",
      "The draft changed before Gmail draft creation and must be approved again.",
      409,
    );
  }

  let mime: ReturnType<typeof buildReplyMime>;
  try {
    mime = buildReplyMime({
      from: {
        address: current.snapshot.mailboxAddress,
        name: current.snapshot.mailboxDisplayName ?? undefined,
      },
      to: current.recipients.map((address) => ({ address })),
      threadSubject: current.snapshot.subject,
      bodyText: current.snapshot.body,
      inReplyTo: current.snapshot.sourceInternetMessageId!,
      references: current.references,
      messageId: rfcMessageId,
      date: dependencies.now(),
    });
  } catch {
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      "MIME_VALIDATION_FAILED",
      dependencies.now(),
    );
    throw new DraftWorkflowError(
      "MIME_VALIDATION_FAILED",
      "The approved draft could not be converted into a safe Gmail reply.",
      409,
    );
  }

  try {
    await dependencies.audit({
      event: "attempted",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "pending",
    });
  } catch {
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      "AUDIT_WRITE_FAILED",
      dependencies.now(),
    );
    throw new DraftWorkflowError(
      "AUDIT_WRITE_FAILED",
      "The execution audit record could not be persisted; Gmail was not called.",
      503,
    );
  }

  let provider: DraftProvider;
  try {
    provider = await dependencies.createProvider(current.snapshot);
  } catch (error) {
    const errorCode = error instanceof DraftWorkflowError
      ? error.code
      : "GMAIL_CREDENTIAL_UNAVAILABLE";
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      errorCode,
      dependencies.now(),
    );
    await dependencies.audit({
      event: "failed",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "failure",
      errorCode,
      integrationResult: "provider_not_called",
    });
    if (error instanceof DraftWorkflowError) throw error;
    throw new DraftWorkflowError(
      "GMAIL_CREDENTIAL_UNAVAILABLE",
      "The Gmail connection could not be used safely.",
      503,
    );
  }

  let finalSnapshot: ValidatedSnapshot;
  try {
    finalSnapshot = await validateSnapshot(
      await dependencies.loadApprovedSnapshot(input.tenantId, input.draftId),
      input.tenantId,
      input.draftId,
      dependencies.now(),
    );
  } catch (error) {
    const errorCode = error instanceof DraftWorkflowError
      ? error.code
      : "FINAL_APPROVAL_VALIDATION_FAILED";
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      errorCode,
      dependencies.now(),
    );
    await dependencies.audit({
      event: "failed",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "failure",
      errorCode,
      integrationResult: "provider_not_called",
    });
    if (error instanceof DraftWorkflowError) throw error;
    throw new DraftWorkflowError(
      "FINAL_APPROVAL_VALIDATION_FAILED",
      "The approval could not be verified immediately before Gmail draft creation.",
      409,
    );
  }

  if (
    finalSnapshot.identity.draftVersionId !== current.identity.draftVersionId ||
    finalSnapshot.identity.contentHash !== current.identity.contentHash ||
    finalSnapshot.approvalId !== current.approvalId ||
    finalSnapshot.snapshot.approvalActionHash !== current.snapshot.approvalActionHash ||
    finalSnapshot.snapshot.sourceInternetMessageId !== current.snapshot.sourceInternetMessageId ||
    finalSnapshot.snapshot.sourceReferencesJson !== current.snapshot.sourceReferencesJson ||
    finalSnapshot.snapshot.providerThreadId !== current.snapshot.providerThreadId ||
    finalSnapshot.snapshot.mailboxId !== current.snapshot.mailboxId
  ) {
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      "failed",
      "DRAFT_CHANGED_BEFORE_PROVIDER_CALL",
      dependencies.now(),
    );
    await dependencies.audit({
      event: "failed",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "failure",
      errorCode: "DRAFT_CHANGED_BEFORE_PROVIDER_CALL",
      integrationResult: "provider_not_called",
    });
    throw new DraftWorkflowError(
      "DRAFT_CHANGED_BEFORE_PROVIDER_CALL",
      "The draft or approval changed before Gmail was called and must be approved again.",
      409,
    );
  }

  let verified: ProviderResult;
  try {
    // GmailClient never retries this POST; ambiguous outcomes are reconciled later.
    const created = await provider.createDraft({
      threadId: current.snapshot.providerThreadId,
      raw: mime.raw,
    });
    const providerResult = validateProviderResult(created, current.snapshot.providerThreadId);
    if (!providerResult) {
      throw new GmailApiError({
        code: "GMAIL_PROTOCOL_ERROR",
        operation: "drafts.create",
        message: "Gmail returned an unverifiable draft result",
      });
    }
    verified = providerResult;
  } catch (error) {
    const ambiguous = isAmbiguousProviderError(error);
    const errorCode = error instanceof GmailApiError ? error.code : "GMAIL_PROVIDER_ERROR";
    await dependencies.markFailed(
      input.tenantId,
      record.id,
      ambiguous ? "ambiguous" : "failed",
      errorCode,
      dependencies.now(),
    );
    await dependencies.audit({
      event: "failed",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "failure",
      errorCode,
      integrationResult: ambiguous ? "ambiguous_provider_result" : "provider_rejected_request",
    });
    throw new DraftWorkflowError(
      ambiguous ? "GMAIL_RESULT_AMBIGUOUS" : "GMAIL_DRAFT_CREATE_FAILED",
      ambiguous
        ? "Gmail did not return a definitive result. The next attempt will reconcile before any retry."
        : "Gmail rejected the draft create request.",
      ambiguous ? 503 : 502,
    );
  }

  const completedAt = dependencies.now();
  try {
    await dependencies.markSucceeded(
      input.tenantId,
      record.id,
      current.identity,
      verified,
      completedAt,
    );
  } catch {
    // Gmail has definitely returned a created draft, but the local result is not
    // durable. Preserve this as ambiguous so the next request only reconciles.
    try {
      await dependencies.markFailed(
        input.tenantId,
        record.id,
        "ambiguous",
        "RESULT_PERSISTENCE_FAILED",
        dependencies.now(),
      );
    } catch {
      // The original persistence failure is the actionable condition.
    }
    throw new DraftWorkflowError(
      "GMAIL_RESULT_AMBIGUOUS",
      "Gmail created a draft but the local confirmation could not be persisted. The next attempt will reconcile first.",
      503,
    );
  }

  try {
    await dependencies.audit({
      event: "succeeded",
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionId: record.id,
      messageId: current.snapshot.messageId,
      threadId: current.snapshot.threadId,
      approvalId: current.approvalId,
      correlationId: input.correlationId,
      requestId: input.requestId,
      idempotencyKey,
      result: "success",
      integrationResult: "gmail_draft_created",
    });
  } catch {
    // The provider and execution result are already durable. Do not turn a
    // confirmed success into a state that could permit another provider POST.
    console.error("Gmail draft succeeded but its success audit append failed");
  }
  return {
    executionId: record.id,
    status: "succeeded",
    providerDraftId: verified.draftId,
    providerMessageId: verified.messageId,
    providerThreadId: verified.threadId,
    replayed: false,
    reconciled: false,
  };
}

async function getDatabase() {
  return (await import("@/db")).getDb();
}

async function loadApprovedSnapshotFromDb(
  tenantId: string,
  draftId: string,
): Promise<ApprovedDraftSnapshot> {
  const db = await getDatabase();
  const [base] = await db
    .select({
      tenantId: drafts.tenantId,
      draftId: drafts.id,
      draftStatus: drafts.status,
      draftCurrentVersion: drafts.currentVersion,
      draftVersionId: draftVersions.id,
      draftVersion: draftVersions.version,
      recipientsJson: draftVersions.recipientsJson,
      subject: draftVersions.subject,
      body: draftVersions.body,
      storedContentHash: draftVersions.contentHash,
      messageId: messages.id,
      sourceInternetMessageId: messages.internetMessageId,
      sourceReferencesJson: messages.referencesJson,
      threadId: threads.id,
      providerThreadId: threads.providerThreadId,
      mailboxId: mailboxes.id,
      mailboxAddress: mailboxes.address,
      mailboxDisplayName: mailboxes.displayName,
      mailboxProvider: mailboxes.provider,
      mailboxStatus: mailboxes.status,
    })
    .from(drafts)
    .innerJoin(
      draftVersions,
      and(
        eq(draftVersions.tenantId, tenantId),
        eq(draftVersions.draftId, drafts.id),
        eq(draftVersions.version, drafts.currentVersion),
      ),
    )
    .innerJoin(
      messages,
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.id, drafts.messageId),
        eq(messages.threadId, drafts.threadId),
        eq(messages.mailboxId, drafts.mailboxId),
      ),
    )
    .innerJoin(
      threads,
      and(
        eq(threads.tenantId, tenantId),
        eq(threads.id, drafts.threadId),
        eq(threads.mailboxId, drafts.mailboxId),
      ),
    )
    .innerJoin(
      mailboxes,
      and(eq(mailboxes.tenantId, tenantId), eq(mailboxes.id, drafts.mailboxId)),
    )
    .where(and(eq(drafts.tenantId, tenantId), eq(drafts.id, draftId)))
    .limit(1);

  if (!base) {
    throw new DraftWorkflowError(
      "DRAFT_NOT_FOUND",
      "Draft was not found in this organisation.",
      404,
    );
  }

  const [latestSource] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.tenantId, tenantId),
        eq(messages.threadId, base.threadId),
        eq(messages.mailboxId, base.mailboxId),
      ),
    )
    .orderBy(desc(messages.receivedAt), desc(messages.id))
    .limit(1);
  if (!latestSource || latestSource.id !== base.messageId) {
    throw new DraftWorkflowError(
      "THREAD_ADVANCED_AFTER_PROPOSAL",
      "A newer message arrived in this thread; create and approve a new reply draft.",
      409,
    );
  }

  const [approval] = await db
    .select({
      id: approvalRequests.id,
      status: approvalRequests.status,
      draftVersionId: approvalRequests.draftVersionId,
      draftVersion: approvalRequests.draftVersion,
      contentHash: approvalRequests.draftContentHash,
      actionHash: approvalRequests.actionHash,
      expiresAt: approvalRequests.expiresAt,
      revokedAt: approvalRequests.revokedAt,
    })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, tenantId),
        eq(approvalRequests.messageId, base.messageId),
        eq(approvalRequests.threadId, base.threadId),
        eq(approvalRequests.draftId, draftId),
        eq(approvalRequests.draftVersionId, base.draftVersionId),
        eq(approvalRequests.draftVersion, base.draftVersion),
      ),
    )
    .limit(1);

  return {
    ...base,
    approvalId: approval?.id ?? null,
    approvalStatus: approval?.status ?? null,
    approvalDraftVersionId: approval?.draftVersionId ?? null,
    approvalDraftVersion: approval?.draftVersion ?? null,
    approvalContentHash: approval?.contentHash ?? null,
    approvalActionHash: approval?.actionHash ?? null,
    approvalExpiresAt: approval?.expiresAt ?? null,
    approvalRevokedAt: approval?.revokedAt ?? null,
  };
}

function mapExecutionRecord(row: typeof actionExecutions.$inferSelect): DraftExecutionRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    idempotencyKey: row.idempotencyKey,
    status: executionStatusSchema.parse(row.status),
    providerDraftId: row.providerResultReference,
    providerMessageId: row.providerMessageId,
    providerThreadId: row.providerThreadId,
    rfcMessageId: row.rfcMessageId,
  };
}

async function claimExecutionInDb(input: ClaimInput) {
  const db = await getDatabase();
  const now = new Date();
  const id = crypto.randomUUID();
  const inserted = await db
    .insert(actionExecutions)
    .values({
      id,
      tenantId: input.identity.tenantId,
      messageId: input.identity.messageId,
      mailboxId: input.identity.mailboxId,
      draftId: input.identity.draftId,
      draftVersionId: input.identity.draftVersionId,
      approvalRequestId: input.approvalId,
      actionType: "create_gmail_draft",
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      status: "proposed",
      rfcMessageId: input.rfcMessageId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [actionExecutions.tenantId, actionExecutions.idempotencyKey],
    })
    .returning();

  const [row] = inserted.length
    ? inserted
    : await db
        .select()
        .from(actionExecutions)
        .where(
          and(
            eq(actionExecutions.tenantId, input.identity.tenantId),
            eq(actionExecutions.idempotencyKey, input.idempotencyKey),
            eq(actionExecutions.messageId, input.identity.messageId),
            eq(actionExecutions.mailboxId, input.identity.mailboxId),
            eq(actionExecutions.draftId, input.identity.draftId),
            eq(actionExecutions.draftVersionId, input.identity.draftVersionId),
            eq(actionExecutions.approvalRequestId, input.approvalId),
            eq(actionExecutions.actionType, "create_gmail_draft"),
          ),
        )
        .limit(1);
  if (!row) {
    throw new DraftWorkflowError(
      "EXECUTION_CLAIM_FAILED",
      "The Gmail draft action could not be claimed safely.",
      503,
    );
  }
  return { record: mapExecutionRecord(row), created: inserted.length === 1 };
}

async function transitionToAttemptingInDb(
  tenantId: string,
  executionId: string,
  allowedStatuses: DraftExecutionStatus[],
  attemptedAt: Date,
) {
  if (allowedStatuses.length === 0) return false;
  const db = await getDatabase();
  const updated = await db
    .update(actionExecutions)
    .set({ status: "attempting", attemptedAt, errorCode: null, updatedAt: attemptedAt })
    .where(
      and(
        eq(actionExecutions.tenantId, tenantId),
        eq(actionExecutions.id, executionId),
        inArray(actionExecutions.status, allowedStatuses),
      ),
    )
    .returning({ id: actionExecutions.id });
  return updated.length === 1;
}

async function markSucceededInDb(
  tenantId: string,
  executionId: string,
  identity: ApprovedDraftIdentity,
  result: ProviderResult,
  completedAt: Date,
) {
  const db = await getDatabase();
  const updatedExecution = await db
    .update(actionExecutions)
    .set({
      status: "succeeded",
      providerResultReference: result.draftId,
      providerMessageId: result.messageId,
      providerThreadId: result.threadId,
      providerConfirmed: true,
      completedAt,
      confirmedAt: completedAt,
      errorCode: null,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(actionExecutions.tenantId, tenantId),
        eq(actionExecutions.id, executionId),
        eq(actionExecutions.messageId, identity.messageId),
        eq(actionExecutions.mailboxId, identity.mailboxId),
        eq(actionExecutions.draftId, identity.draftId),
        eq(actionExecutions.draftVersionId, identity.draftVersionId),
        inArray(actionExecutions.status, ["attempting", "ambiguous"]),
      ),
    )
    .returning({ id: actionExecutions.id });
  if (updatedExecution.length !== 1) {
    throw new Error("Execution result was not persisted from an eligible state.");
  }

  // If a human edited concurrently while Gmail was processing, the exact old
  // execution remains succeeded but the newer local version is not overwritten.
  await db
    .update(drafts)
    .set({ status: "executed", updatedAt: completedAt })
    .where(
      and(
        eq(drafts.tenantId, tenantId),
        eq(drafts.id, identity.draftId),
        eq(drafts.currentVersion, identity.draftVersion),
        eq(drafts.status, "approved"),
      ),
    );
}

async function markFailedInDb(
  tenantId: string,
  executionId: string,
  status: "failed" | "ambiguous",
  errorCode: string,
  completedAt: Date,
) {
  const db = await getDatabase();
  await db
    .update(actionExecutions)
    .set({ status, errorCode: errorCode.slice(0, 64), completedAt, updatedAt: completedAt })
    .where(
      and(
        eq(actionExecutions.tenantId, tenantId),
        eq(actionExecutions.id, executionId),
        inArray(actionExecutions.status, ["proposed", "attempting", "failed", "ambiguous"]),
      ),
    );
}

async function createProviderFromDb(snapshot: ApprovedDraftSnapshot): Promise<DraftProvider> {
  const environment = loadEnvironment();
  if (!environment.GMAIL_INTEGRATION_ENABLED) {
    throw new DraftWorkflowError(
      "GMAIL_INTEGRATION_DISABLED",
      "Gmail integration is disabled until the owner completes configuration.",
      409,
    );
  }

  const db = await getDatabase();
  const [credential] = await db
    .select({
      id: mailboxCredentials.id,
      accessTokenEncrypted: mailboxCredentials.accessTokenEncrypted,
      refreshTokenEncrypted: mailboxCredentials.refreshTokenEncrypted,
      tokenExpiresAt: mailboxCredentials.tokenExpiresAt,
    })
    .from(mailboxCredentials)
    .innerJoin(
      mailboxes,
      and(
        eq(mailboxes.tenantId, snapshot.tenantId),
        eq(mailboxes.id, mailboxCredentials.mailboxId),
        eq(mailboxes.status, "active"),
        eq(mailboxes.provider, "gmail"),
      ),
    )
    .where(
      and(
        eq(mailboxCredentials.tenantId, snapshot.tenantId),
        eq(mailboxCredentials.mailboxId, snapshot.mailboxId),
      ),
    )
    .limit(1);
  if (!credential) {
    throw new DraftWorkflowError(
      "GMAIL_CREDENTIAL_UNAVAILABLE",
      "The Gmail connection must be restored before creating a draft.",
      409,
    );
  }

  const key = environment.APP_ENCRYPTION_KEY!;
  const accessAad = buildSecretAad({
    tenantId: snapshot.tenantId,
    resourceType: "mailbox_credential",
    resourceId: credential.id,
    field: "access_token",
  });
  let accessToken = await decryptSecret(credential.accessTokenEncrypted, key, accessAad);

  if (credential.tokenExpiresAt.getTime() <= Date.now() + 60_000) {
    if (!credential.refreshTokenEncrypted) {
      throw new DraftWorkflowError(
        "GMAIL_REAUTHORIZATION_REQUIRED",
        "The Gmail connection has expired and must be authorized again.",
        409,
      );
    }
    const refreshAad = buildSecretAad({
      tenantId: snapshot.tenantId,
      resourceType: "mailbox_credential",
      resourceId: credential.id,
      field: "refresh_token",
    });
    const refreshToken = await decryptSecret(credential.refreshTokenEncrypted, key, refreshAad);
    const refreshed = await refreshGoogleAccessToken({
      client: {
        clientId: environment.GOOGLE_CLIENT_ID!,
        clientSecret: environment.GOOGLE_CLIENT_SECRET!,
        redirectUri: environment.GOOGLE_REDIRECT_URI!,
      },
      refreshToken,
    });
    accessToken = refreshed.accessToken;
    const now = new Date();
    const expiresAt = new Date(refreshed.expiresAt);
    const encryptedAccessToken = await encryptSecret(accessToken, key, accessAad);
    const encryptedRefreshToken = refreshed.refreshToken
      ? await encryptSecret(refreshed.refreshToken, key, refreshAad)
      : credential.refreshTokenEncrypted;
    await db.batch([
      db
        .update(mailboxCredentials)
        .set({
          accessTokenEncrypted: encryptedAccessToken,
          refreshTokenEncrypted: encryptedRefreshToken,
          tokenExpiresAt: expiresAt,
          updatedAt: now,
        })
        .where(
          and(
            eq(mailboxCredentials.tenantId, snapshot.tenantId),
            eq(mailboxCredentials.mailboxId, snapshot.mailboxId),
            eq(mailboxCredentials.id, credential.id),
          ),
        ),
      db
        .update(mailboxes)
        .set({ tokenExpiresAt: expiresAt, updatedAt: now })
        .where(
          and(
            eq(mailboxes.tenantId, snapshot.tenantId),
            eq(mailboxes.id, snapshot.mailboxId),
          ),
        ),
    ]);
  }

  return new GmailClient({ accessToken, maxReadRetries: 2, timeoutMs: 12_000 });
}

async function appendSafeAudit(input: SafeAuditInput) {
  const { appendAuditEvent } = await import("@/lib/audit");
  await appendAuditEvent({
    tenantId: input.tenantId,
    actorType: input.event === "attempted" ? "user" : "integration",
    actorId: input.actorId,
    eventType: `gmail_draft.${input.event}`,
    action: "create_gmail_draft",
    targetType: "action_execution",
    targetId: input.executionId,
    messageId: input.messageId,
    threadId: input.threadId,
    approvalStatus: "approved",
    result: input.result,
    requestId: input.requestId,
    correlationId: input.correlationId,
    idempotencyKey: `audit:${input.executionId}:${input.event}:${input.requestId}`,
    integrationResult: input.integrationResult,
    metadata: {
      approvalId: input.approvalId,
      executionId: input.executionId,
      actionIdempotencyKey: input.idempotencyKey,
      ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    },
  });
}

export const databaseDraftExecutionDependencies: DraftExecutionDependencies = {
  now: () => new Date(),
  loadApprovedSnapshot: loadApprovedSnapshotFromDb,
  claimExecution: claimExecutionInDb,
  transitionToAttempting: transitionToAttemptingInDb,
  markSucceeded: markSucceededInDb,
  markFailed: markFailedInDb,
  createProvider: createProviderFromDb,
  audit: appendSafeAudit,
};

export async function executeApprovedGmailDraft(input: ExecuteApprovedDraftInput) {
  return executeApprovedDraftWorkflow(input, databaseDraftExecutionDependencies);
}
