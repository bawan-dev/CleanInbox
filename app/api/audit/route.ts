import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);
    const messageId = new URL(request.url).searchParams.get("messageId");

    const rows = await getDb()
      .select({
        id: auditEvents.id,
        eventType: auditEvents.eventType,
        action: auditEvents.action,
        targetType: auditEvents.targetType,
        targetId: auditEvents.targetId,
        result: auditEvents.result,
        actorType: auditEvents.actorType,
        actorId: auditEvents.actorId,
        redactedDetailJson: auditEvents.redactedDetailJson,
        correlationId: auditEvents.correlationId,
        createdAt: auditEvents.createdAt,
      })
      .from(auditEvents)
      .where(
        messageId
          ? and(
              eq(auditEvents.tenantId, context.tenantId),
              eq(auditEvents.messageId, messageId),
            )
          : eq(auditEvents.tenantId, context.tenantId),
      )
      .orderBy(desc(auditEvents.createdAt))
      .limit(200);

    return Response.json({ events: rows });
  } catch (error) {
    return jsonError(error);
  }
}

