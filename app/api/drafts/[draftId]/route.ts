import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { approvalRequests } from "@/db/schema";
import { editDraft, loadCurrentDraft } from "@/lib/drafts/service";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

const resourceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const editSchema = z.object({ body: z.string().trim().min(1).max(50_000) }).strict();

async function parseDraftId(params: Promise<{ draftId: string }>) {
  const result = resourceIdSchema.safeParse((await params).draftId);
  return result.success ? result.data : null;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const draftId = await parseDraftId(params);
    if (!draftId) {
      return Response.json({ error: "A valid draft identifier is required." }, { status: 400 });
    }

    const draft = await loadCurrentDraft(context.tenantId, draftId);
    const [approval] = await getDb()
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
          eq(approvalRequests.messageId, draft.messageId),
          eq(approvalRequests.threadId, draft.threadId),
          eq(approvalRequests.draftId, draftId),
          eq(approvalRequests.draftVersionId, draft.versionId),
        ),
      )
      .limit(1);
    return Response.json({ draft, approval: approval ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const draftId = await parseDraftId(params);
    if (!draftId) {
      return Response.json({ error: "A valid draft identifier is required." }, { status: 400 });
    }
    const parsed = editSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json({ error: "A draft body is required." }, { status: 400 });
    }

    return Response.json(await editDraft(context, draftId, parsed.data.body));
  } catch (error) {
    return jsonError(error);
  }
}

export const PUT = PATCH;
