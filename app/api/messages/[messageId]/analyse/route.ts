import { analyzeImportedMessage } from "@/lib/ai/analysis-service";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ messageId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner", "reviewer"]);
    const { messageId } = await routeContext.params;
    if (!messageId || messageId.length > 128) {
      return Response.json({ error: "Message identifier is invalid." }, { status: 400 });
    }

    const result = await analyzeImportedMessage(context, messageId);
    return Response.json(result);
  } catch (error) {
    return jsonError(error);
  }
}

