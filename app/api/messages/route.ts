import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { messages, threads } from "@/db/schema";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const db = getDb();
    const tenantMessages = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        senderName: messages.senderName,
        senderEmail: messages.senderEmail,
        subject: messages.subject,
        receivedAt: messages.receivedAt,
        ingestionStatus: messages.ingestionStatus,
        threadStatus: threads.status,
      })
      .from(messages)
      .innerJoin(
        threads,
        and(
          eq(messages.threadId, threads.id),
          eq(threads.tenantId, context.tenantId),
        ),
      )
      .where(eq(messages.tenantId, context.tenantId))
      .orderBy(desc(messages.receivedAt))
      .limit(100);

    return Response.json({ messages: tenantMessages });
  } catch (error) {
    return jsonError(error);
  }
}
