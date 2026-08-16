import { getDb } from "@/db";
import { appendAuditEvent } from "@/lib/audit";
import { purgeExpiredOAuthAttempts, redactExpiredMessageContent } from "@/lib/retention";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);
    const db = getDb();
    const now = new Date();
    const [redacted, removedOAuthAttempts] = await Promise.all([
      redactExpiredMessageContent(context.tenantId, now, db),
      purgeExpiredOAuthAttempts(context.tenantId, now, db),
    ]);

    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: "retention.applied",
        action: "redact_expired_message_content",
        targetType: "tenant",
        targetId: context.tenantId,
        result: "success",
        metadata: {
          redactedMessages: redacted.length,
          removedOAuthAttempts: removedOAuthAttempts.length,
        },
      },
      db,
    );

    return Response.json({
      redactedMessages: redacted.length,
      removedOAuthAttempts: removedOAuthAttempts.length,
    });
  } catch (error) {
    return jsonError(error);
  }
}
