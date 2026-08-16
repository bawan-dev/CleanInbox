import { z } from "zod";
import { approveCurrentDraft } from "@/lib/drafts/service";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

const resourceIdSchema = z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const approvalInputSchema = z.object({}).strict();

export async function POST(
  request: Request,
  { params }: { params: Promise<{ draftId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const draftId = resourceIdSchema.safeParse((await params).draftId);
    if (!draftId.success) {
      return Response.json({ error: "A valid draft identifier is required." }, { status: 400 });
    }
    const bodyText = await request.text();
    const raw = bodyText.trim()
      ? (() => {
          try {
            return JSON.parse(bodyText) as unknown;
          } catch {
            return undefined;
          }
        })()
      : {};
    if (!approvalInputSchema.safeParse(raw).success) {
      return Response.json({ error: "Approval does not accept client-supplied state." }, { status: 400 });
    }

    return Response.json(await approveCurrentDraft(context, draftId.data));
  } catch (error) {
    return jsonError(error);
  }
}
