import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { drafts, messageAnalyses, messages, threads } from "@/db/schema";
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
        snippet: messages.snippet,
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

    const messageIds = tenantMessages.map((message) => message.id);
    const [analysisRows, draftRows] = messageIds.length
      ? await Promise.all([
          db
            .select({
              messageId: messageAnalyses.messageId,
              category: messageAnalyses.primaryCategory,
              priority: messageAnalyses.priority,
              summary: messageAnalyses.summary,
              riskFlagsJson: messageAnalyses.riskFlagsJson,
              confidence: messageAnalyses.confidenceScore,
              replyRequired: messageAnalyses.replyRequired,
              version: messageAnalyses.version,
            })
            .from(messageAnalyses)
            .where(
              and(
                eq(messageAnalyses.tenantId, context.tenantId),
                inArray(messageAnalyses.messageId, messageIds),
              ),
            )
            .orderBy(desc(messageAnalyses.version)),
          db
            .select({
              messageId: drafts.messageId,
              id: drafts.id,
              status: drafts.status,
              currentVersion: drafts.currentVersion,
            })
            .from(drafts)
            .where(
              and(
                eq(drafts.tenantId, context.tenantId),
                inArray(drafts.messageId, messageIds),
              ),
            )
            .orderBy(desc(drafts.updatedAt)),
        ])
      : [[], []];

    const latestAnalysis = new Map<string, (typeof analysisRows)[number]>();
    for (const analysis of analysisRows) {
      if (!latestAnalysis.has(analysis.messageId)) latestAnalysis.set(analysis.messageId, analysis);
    }
    const latestDraft = new Map<string, (typeof draftRows)[number]>();
    for (const draft of draftRows) {
      if (!latestDraft.has(draft.messageId)) latestDraft.set(draft.messageId, draft);
    }

    return Response.json({
      messages: tenantMessages.map((message) => ({
        ...message,
        analysis: latestAnalysis.get(message.id) ?? null,
        draft: latestDraft.get(message.id) ?? null,
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
