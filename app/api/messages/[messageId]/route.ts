import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  actionExecutions,
  approvalRequests,
  attachments,
  drafts,
  draftVersions,
  mailboxes,
  messageAnalyses,
  messages,
  threads,
} from "@/db/schema";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

function jsonArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET(
  request: Request,
  routeContext: { params: Promise<{ messageId: string }> },
) {
  try {
    const context = await resolveTenantContext(request.headers);
    const { messageId } = await routeContext.params;
    if (!messageId || messageId.length > 128) {
      return Response.json({ error: "Message identifier is invalid." }, { status: 400 });
    }

    const db = getDb();
    const [target] = await db
      .select({
        id: messages.id,
        threadId: messages.threadId,
        mailboxId: messages.mailboxId,
        threadSubject: threads.subject,
        threadStatus: threads.status,
        completeThreadImported: threads.completeThreadImported,
        mailboxAddress: mailboxes.address,
      })
      .from(messages)
      .innerJoin(
        threads,
        and(
          eq(threads.id, messages.threadId),
          eq(threads.tenantId, context.tenantId),
          eq(threads.mailboxId, messages.mailboxId),
        ),
      )
      .innerJoin(
        mailboxes,
        and(
          eq(mailboxes.id, messages.mailboxId),
          eq(mailboxes.tenantId, context.tenantId),
        ),
      )
      .where(and(eq(messages.id, messageId), eq(messages.tenantId, context.tenantId)))
      .limit(1);
    if (!target) {
      return Response.json({ error: "Message was not found." }, { status: 404 });
    }

    const [threadMessages, analysisRows, draftRows] = await Promise.all([
      db
        .select({
          id: messages.id,
          providerMessageId: messages.providerMessageId,
          senderName: messages.senderName,
          senderEmail: messages.senderEmail,
          replyToEmail: messages.replyToEmail,
          recipientsJson: messages.recipientsJson,
          copiedRecipientsJson: messages.copiedRecipientsJson,
          subject: messages.subject,
          textBody: messages.textBody,
          receivedAt: messages.receivedAt,
          labelsJson: messages.labelsJson,
        })
        .from(messages)
        .where(
          and(
            eq(messages.tenantId, context.tenantId),
            eq(messages.threadId, target.threadId),
            eq(messages.mailboxId, target.mailboxId),
          ),
        )
        .orderBy(asc(messages.receivedAt)),
      db
        .select()
        .from(messageAnalyses)
        .where(
          and(
            eq(messageAnalyses.tenantId, context.tenantId),
            eq(messageAnalyses.messageId, messageId),
          ),
        )
        .orderBy(desc(messageAnalyses.version))
        .limit(1),
      db
        .select({
          id: drafts.id,
          status: drafts.status,
          currentVersion: drafts.currentVersion,
          versionId: draftVersions.id,
          version: draftVersions.version,
          recipientsJson: draftVersions.recipientsJson,
          subject: draftVersions.subject,
          body: draftVersions.body,
          contentHash: draftVersions.contentHash,
          approvalId: approvalRequests.id,
          approvalStatus: approvalRequests.status,
          approvalExpiresAt: approvalRequests.expiresAt,
          providerDraftId: actionExecutions.providerResultReference,
          providerConfirmed: actionExecutions.providerConfirmed,
        })
        .from(drafts)
        .innerJoin(
          draftVersions,
          and(
            eq(draftVersions.draftId, drafts.id),
            eq(draftVersions.tenantId, context.tenantId),
            eq(draftVersions.version, drafts.currentVersion),
          ),
        )
        .leftJoin(
          approvalRequests,
          and(
            eq(approvalRequests.draftVersionId, draftVersions.id),
            eq(approvalRequests.tenantId, context.tenantId),
          ),
        )
        .leftJoin(
          actionExecutions,
          and(
            eq(actionExecutions.draftVersionId, draftVersions.id),
            eq(actionExecutions.tenantId, context.tenantId),
          ),
        )
        .where(
          and(eq(drafts.tenantId, context.tenantId), eq(drafts.messageId, messageId)),
        )
        .orderBy(desc(drafts.updatedAt))
        .limit(1),
    ]);

    const messageAttachments = await db
      .select({
        id: attachments.id,
        messageId: attachments.messageId,
        filename: attachments.filename,
        mimeType: attachments.mimeType,
        sizeBytes: attachments.sizeBytes,
        riskLevel: attachments.riskLevel,
      })
      .from(attachments)
      .where(
        and(
          eq(attachments.tenantId, context.tenantId),
          eq(attachments.messageId, messageId),
        ),
      );

    const analysis = analysisRows[0];
    return Response.json({
      thread: {
        id: target.threadId,
        subject: target.threadSubject,
        status: target.threadStatus,
        complete: target.completeThreadImported,
        messages: threadMessages.map((message) => ({
          ...message,
          recipients: jsonArray(message.recipientsJson),
          copiedRecipients: jsonArray(message.copiedRecipientsJson),
          labels: jsonArray(message.labelsJson),
          recipientsJson: undefined,
          copiedRecipientsJson: undefined,
          labelsJson: undefined,
        })),
      },
      analysis: analysis
        ? {
            ...analysis,
            secondaryCategories: jsonArray(analysis.secondaryCategoriesJson),
            requiredActions: jsonArray(analysis.requiredActionsJson),
            riskFlags: jsonArray(analysis.riskFlagsJson),
            detectedDates: jsonArray(analysis.detectedDatesJson),
            detectedDeadlines: jsonArray(analysis.detectedDeadlinesJson),
            detectedFinancialAmounts: jsonArray(analysis.detectedFinancialAmountsJson),
            secondaryCategoriesJson: undefined,
            requiredActionsJson: undefined,
            riskFlagsJson: undefined,
            detectedDatesJson: undefined,
            detectedDeadlinesJson: undefined,
            detectedFinancialAmountsJson: undefined,
          }
        : null,
      draft: draftRows[0]
        ? { ...draftRows[0], recipients: jsonArray(draftRows[0].recipientsJson), recipientsJson: undefined }
        : null,
      attachments: messageAttachments,
      safety: { htmlRendered: false, remoteContentLoaded: false, attachmentsProcessed: false },
    });
  } catch (error) {
    return jsonError(error);
  }
}

