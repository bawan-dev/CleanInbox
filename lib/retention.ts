import { and, eq, lt, ne } from "drizzle-orm";
import { getDb } from "@/db";
import { gmailOAuthAttempts, messages } from "@/db/schema";
import { REDACTED_EMAIL_CONTENT } from "@/lib/retention-policy";

export { REDACTED_EMAIL_CONTENT, retentionDeadline } from "@/lib/retention-policy";

export async function redactExpiredMessageContent(
  tenantId: string,
  now = new Date(),
  db: ReturnType<typeof getDb> = getDb(),
) {
  return db
    .update(messages)
    .set({
      textBody: REDACTED_EMAIL_CONTENT,
      snippet: "",
      updatedAt: now,
    })
    .where(
      and(
        eq(messages.tenantId, tenantId),
        lt(messages.contentRetainUntil, now),
        ne(messages.textBody, REDACTED_EMAIL_CONTENT),
      ),
    )
    .returning({ id: messages.id });
}

export async function purgeExpiredOAuthAttempts(
  tenantId: string,
  now = new Date(),
  db: ReturnType<typeof getDb> = getDb(),
) {
  return db
    .delete(gmailOAuthAttempts)
    .where(
      and(
        eq(gmailOAuthAttempts.tenantId, tenantId),
        lt(gmailOAuthAttempts.expiresAt, now),
      ),
    )
    .returning({ id: gmailOAuthAttempts.id });
}
