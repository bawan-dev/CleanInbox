import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  approvalRequests,
  drafts,
  draftVersions,
  mailboxes,
  messageAnalyses,
  messages,
  threads,
} from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import {
  calculateApprovalActionHash,
  calculateDraftContentHash,
  sha256Hex,
} from "@/lib/drafts/integrity";
import { ConflictError, NotFoundError, type TenantContext } from "@/lib/tenant-context";

type CreateProposalInput = {
  context: TenantContext;
  messageId: string;
  body: string;
  sourceAnalysisId?: string;
  authorType: "assistant" | "human";
};

function replySubject(subject: string) {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

async function loadReplyContext(tenantId: string, messageId: string) {
  const [row] = await getDb()
    .select({
      messageId: messages.id,
      threadId: messages.threadId,
      mailboxId: messages.mailboxId,
      senderEmail: messages.senderEmail,
      replyToEmail: messages.replyToEmail,
      subject: messages.subject,
    })
    .from(messages)
    .innerJoin(
      threads,
      and(
        eq(threads.id, messages.threadId),
        eq(threads.tenantId, tenantId),
        eq(threads.mailboxId, messages.mailboxId),
      ),
    )
    .innerJoin(
      mailboxes,
      and(
        eq(mailboxes.id, messages.mailboxId),
        eq(mailboxes.tenantId, tenantId),
        eq(mailboxes.status, "active"),
      ),
    )
    .where(and(eq(messages.id, messageId), eq(messages.tenantId, tenantId)))
    .limit(1);

  if (!row) {
    throw new NotFoundError("Message was not found in this organisation.");
  }

  return row;
}

export async function createDraftProposal(input: CreateProposalInput) {
  const body = input.body.trim();
  if (!body || body.length > 50_000) {
    throw new ConflictError("Draft body must contain between 1 and 50,000 characters.");
  }

  const source = await loadReplyContext(input.context.tenantId, input.messageId);
  if (input.sourceAnalysisId) {
    const [analysis] = await getDb()
      .select({ id: messageAnalyses.id })
      .from(messageAnalyses)
      .where(
        and(
          eq(messageAnalyses.id, input.sourceAnalysisId),
          eq(messageAnalyses.tenantId, input.context.tenantId),
          eq(messageAnalyses.messageId, input.messageId),
        ),
      )
      .limit(1);
    if (!analysis) {
      throw new NotFoundError("Analysis was not found in this organisation.");
    }
  }

  const recipients = [source.replyToEmail || source.senderEmail];
  const subject = replySubject(source.subject);
  const contentHash = await calculateDraftContentHash({ recipients, subject, body });
  const proposalKey = await sha256Hex(
    `proposal:${input.context.tenantId}:${input.messageId}:${input.sourceAnalysisId ?? "manual"}:${contentHash}`,
  );
  const db = getDb();
  const [existing] = await db
    .select({
      id: drafts.id,
      status: drafts.status,
      currentVersion: drafts.currentVersion,
    })
    .from(drafts)
    .where(
      and(
        eq(drafts.tenantId, input.context.tenantId),
        eq(drafts.proposalKey, proposalKey),
      ),
    )
    .limit(1);

  if (existing) {
    return { draft: existing, replayed: true };
  }

  const now = new Date();
  const draftId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await db.batch([
    db.insert(drafts).values({
      id: draftId,
      tenantId: input.context.tenantId,
      messageId: source.messageId,
      threadId: source.threadId,
      mailboxId: source.mailboxId,
      proposalKey,
      sourceAnalysisId: input.sourceAnalysisId,
      status: "proposed",
      currentVersion: 1,
      createdBy: input.context.userId,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(draftVersions).values({
      id: versionId,
      tenantId: input.context.tenantId,
      draftId,
      version: 1,
      recipientsJson: JSON.stringify(recipients),
      subject,
      body,
      contentHash,
      authorType: input.authorType,
      createdBy: input.context.userId,
      createdAt: now,
    }),
  ]);

  await appendAuditEvent(
    {
      tenantId: input.context.tenantId,
      actorType: input.authorType === "assistant" ? "assistant" : "user",
      actorId: input.context.userId,
      eventType: "draft.proposed",
      action: "propose_draft",
      targetType: "draft",
      targetId: draftId,
      messageId: source.messageId,
      threadId: source.threadId,
      result: "success",
      idempotencyKey: `audit:${proposalKey}`,
      metadata: { version: 1, source: input.authorType },
    },
    db,
  );

  return {
    draft: { id: draftId, status: "proposed" as const, currentVersion: 1, versionId },
    replayed: false,
  };
}

export async function loadCurrentDraft(tenantId: string, draftId: string) {
  const [row] = await getDb()
    .select({
      id: drafts.id,
      tenantId: drafts.tenantId,
      mailboxId: drafts.mailboxId,
      messageId: drafts.messageId,
      threadId: drafts.threadId,
      status: drafts.status,
      currentVersion: drafts.currentVersion,
      versionId: draftVersions.id,
      version: draftVersions.version,
      recipientsJson: draftVersions.recipientsJson,
      subject: draftVersions.subject,
      body: draftVersions.body,
      contentHash: draftVersions.contentHash,
    })
    .from(drafts)
    .innerJoin(
      draftVersions,
      and(
        eq(draftVersions.draftId, drafts.id),
        eq(draftVersions.tenantId, tenantId),
        eq(draftVersions.version, drafts.currentVersion),
      ),
    )
    .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, tenantId)))
    .limit(1);

  if (!row) {
    throw new NotFoundError("Draft was not found in this organisation.");
  }

  return row;
}

export async function editDraft(context: TenantContext, draftId: string, rawBody: string) {
  const body = rawBody.trim();
  if (!body || body.length > 50_000) {
    throw new ConflictError("Draft body must contain between 1 and 50,000 characters.");
  }

  const current = await loadCurrentDraft(context.tenantId, draftId);
  if (current.status === "executed" || current.status === "rejected") {
    throw new ConflictError("This draft can no longer be edited.");
  }

  const recipients = JSON.parse(current.recipientsJson) as string[];
  const contentHash = await calculateDraftContentHash({
    recipients,
    subject: current.subject,
    body,
  });

  if (contentHash === current.contentHash) {
    return { draft: current, replayed: true };
  }

  const db = getDb();
  const now = new Date();
  const version = current.version + 1;
  const versionId = crypto.randomUUID();
  await db.batch([
    db.insert(draftVersions).values({
      id: versionId,
      tenantId: context.tenantId,
      draftId,
      version,
      recipientsJson: current.recipientsJson,
      subject: current.subject,
      body,
      contentHash,
      authorType: "human",
      createdBy: context.userId,
      createdAt: now,
    }),
    db
      .update(drafts)
      .set({ currentVersion: version, status: "edited", updatedAt: now })
      .where(
        and(
          eq(drafts.id, draftId),
          eq(drafts.tenantId, context.tenantId),
          eq(drafts.currentVersion, current.version),
        ),
      ),
    db
      .update(approvalRequests)
      .set({
        status: "revoked",
        revokedAt: now,
        decidedBy: context.userId,
        decisionNote: "Draft content changed after this approval was recorded.",
        updatedAt: now,
      })
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenantId),
          eq(approvalRequests.draftId, draftId),
          inArray(approvalRequests.status, ["pending", "approved"]),
        ),
      ),
  ]);

  await appendAuditEvent(
    {
      tenantId: context.tenantId,
      actorType: "user",
      actorId: context.userId,
      eventType: "draft.edited",
      action: "edit_draft",
      targetType: "draft_version",
      targetId: versionId,
      messageId: current.messageId,
      threadId: current.threadId,
      result: "success",
      metadata: { draftId, version, previousVersion: current.version },
    },
    db,
  );

  return {
    draft: { ...current, status: "edited" as const, currentVersion: version, version, versionId, body, contentHash },
    replayed: false,
  };
}

export async function approveCurrentDraft(context: TenantContext, draftId: string) {
  const current = await loadCurrentDraft(context.tenantId, draftId);
  if (current.status === "executed" || current.status === "rejected") {
    throw new ConflictError("This draft cannot be approved in its current state.");
  }

  const recipients = JSON.parse(current.recipientsJson) as string[];
  const calculatedHash = await calculateDraftContentHash({
    recipients,
    subject: current.subject,
    body: current.body,
  });
  if (calculatedHash !== current.contentHash) {
    throw new ConflictError("Draft integrity verification failed; create a new version before approval.");
  }

  const actionHash = await calculateApprovalActionHash({
    tenantId: context.tenantId,
    mailboxId: current.mailboxId,
    messageId: current.messageId,
    threadId: current.threadId,
    draftId: current.id,
    draftVersionId: current.versionId,
    draftVersion: current.version,
    contentHash: current.contentHash,
  });
  const db = getDb();
  const [existing] = await db
    .select()
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, context.tenantId),
        eq(approvalRequests.draftVersionId, current.versionId),
      ),
    )
    .limit(1);

  if (existing?.status === "approved" && existing.expiresAt.getTime() > Date.now()) {
    return { approval: existing, replayed: true };
  }
  if (existing) {
    throw new ConflictError("This draft version has an expired, rejected, or revoked approval.");
  }

  const now = new Date();
  const approvalId = crypto.randomUUID();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
  await db.batch([
    db.insert(approvalRequests).values({
      id: approvalId,
      tenantId: context.tenantId,
      messageId: current.messageId,
      threadId: current.threadId,
      draftId: current.id,
      draftVersionId: current.versionId,
      draftVersion: current.version,
      draftContentHash: current.contentHash,
      actionType: "create_gmail_draft",
      actionHash,
      status: "approved",
      requestedBy: context.userId,
      decidedBy: context.userId,
      decidedAt: now,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    }),
    db
      .update(drafts)
      .set({ status: "approved", updatedAt: now })
      .where(and(eq(drafts.id, draftId), eq(drafts.tenantId, context.tenantId))),
  ]);

  await appendAuditEvent(
    {
      tenantId: context.tenantId,
      actorType: "user",
      actorId: context.userId,
      eventType: "draft.approved",
      action: "approve_draft",
      targetType: "approval",
      targetId: approvalId,
      messageId: current.messageId,
      threadId: current.threadId,
      result: "success",
      approvalStatus: "approved",
      idempotencyKey: `audit:${actionHash}`,
      metadata: { draftId, version: current.version, expiresAt: expiresAt.toISOString() },
    },
    db,
  );

  return {
    approval: {
      id: approvalId,
      status: "approved" as const,
      draftVersionId: current.versionId,
      draftVersion: current.version,
      draftContentHash: current.contentHash,
      expiresAt,
    },
    replayed: false,
  };
}

