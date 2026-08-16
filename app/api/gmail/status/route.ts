import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { mailboxes } from "@/db/schema";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const rows = await getDb()
      .select({
        id: mailboxes.id,
        provider: mailboxes.provider,
        address: mailboxes.address,
        displayName: mailboxes.displayName,
        status: mailboxes.status,
        lastSuccessfulSyncAt: mailboxes.lastSuccessfulSyncAt,
        connectionErrorCode: mailboxes.connectionErrorCode,
        disconnectedAt: mailboxes.disconnectedAt,
      })
      .from(mailboxes)
      .where(eq(mailboxes.tenantId, context.tenantId))
      .orderBy(desc(mailboxes.updatedAt))
      .limit(1);

    return Response.json({ mailbox: rows[0] ?? null });
  } catch (error) {
    return jsonError(error);
  }
}

