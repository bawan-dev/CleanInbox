import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { approvalRequests, drafts, messages } from "@/db/schema";
import { createDraftProposal, loadCurrentDraft } from "@/lib/drafts/service";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

const resourceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const proposalSchema = z
  .object({
    body: z.string().trim().min(1).max(50_000),
    sourceAnalysisId: resourceIdSchema.optional(),
  })
  .strict();

async function parseMessageId(params: Promise<{ messageId: string }>) {
  const result = resourceIdSchema.safeParse((await params).messageId);
  if (!result.success) return null;
  return result.data;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const messageId = await parseMessageId(params);
    if (!messageId) {
      return Response.json({ error: "A valid message identifier is required." }, { status: 400 });
    }

    const db = getDb();
    const [latest] = await db
      .select({ id: drafts.id })
      .from(drafts)
      .innerJoin(
        messages,
        and(
          eq(messages.tenantId, context.tenantId),
          eq(messages.id, drafts.messageId),
          eq(messages.threadId, drafts.threadId),
          eq(messages.mailboxId, drafts.mailboxId),
        ),
      )
      .where(
        and(
          eq(drafts.tenantId, context.tenantId),
          eq(drafts.messageId, messageId),
        ),
      )
      .orderBy(desc(drafts.updatedAt))
      .limit(1);
    if (!latest) return Response.json({ draft: null });

    const draft = await loadCurrentDraft(context.tenantId, latest.id);
    const [approval] = await db
      .select({
        id: approvalRequests.id,
        status: approvalRequests.status,
        draftVersion: approvalRequests.draftVersion,
        expiresAt: approvalRequests.expiresAt,
        revokedAt: approvalRequests.revokedAt,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, context.tenantId),
          eq(approvalRequests.messageId, messageId),
          eq(approvalRequests.draftId, draft.id),
          eq(approvalRequests.draftVersionId, draft.versionId),
        ),
      )
      .limit(1);

    return Response.json({ draft, approval: approval ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const messageId = await parseMessageId(params);
    if (!messageId) {
      return Response.json({ error: "A valid message identifier is required." }, { status: 400 });
    }
    const parsed = proposalSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json(
        { error: "A draft body and optional valid source analysis are required." },
        { status: 400 },
      );
    }

    const result = await createDraftProposal({
      context,
      messageId,
      body: parsed.data.body,
      sourceAnalysisId: parsed.data.sourceAnalysisId,
      authorType: "human",
    });
    return Response.json(result, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
