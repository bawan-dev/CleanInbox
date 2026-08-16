import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import {
  attachments,
  mailboxes,
  memberships,
  messageAnalyses,
  messages,
  tenantSettings,
  threads,
} from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import {
  createOpenAIAnalysisClient,
  EMAIL_ANALYSIS_PROMPT_VERSION,
  loadOpenAIAnalysisConfig,
  OpenAIAnalysisError,
  type OpenAIAnalysisClient,
} from "@/lib/ai";
import { createDraftProposal } from "@/lib/drafts/service";
import { REDACTED_EMAIL_CONTENT } from "@/lib/retention-policy";
import { sha256Hex } from "@/lib/security/crypto";
import { ConflictError, NotFoundError, type TenantContext } from "@/lib/tenant-context";

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string").slice(0, 100)
      : [];
  } catch {
    return [];
  }
}

export async function analyzeImportedMessage(
  context: TenantContext,
  messageId: string,
  client?: OpenAIAnalysisClient,
) {
  const aiConfig = loadOpenAIAnalysisConfig();
  const analysisClient = client ?? createOpenAIAnalysisClient(aiConfig);
  const db = getDb();
  const [target] = await db
    .select({
      id: messages.id,
      threadId: messages.threadId,
      mailboxId: messages.mailboxId,
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
        eq(mailboxes.status, "active"),
      ),
    )
    .where(and(eq(messages.id, messageId), eq(messages.tenantId, context.tenantId)))
    .limit(1);

  if (!target) {
    throw new NotFoundError("Message was not found in this organisation.");
  }
  if (!target.completeThreadImported) {
    throw new ConflictError("The complete Gmail thread must be imported before analysis.");
  }

  const [settings, tenantMessages, activeMembers] = await Promise.all([
    db
      .select({
        businessTimezone: tenantSettings.businessTimezone,
        businessInstructions: tenantSettings.businessInstructions,
        minimumConfidence: tenantSettings.minimumClassificationConfidence,
        version: tenantSettings.version,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .limit(1)
      .then((rows) => rows[0]),
    db
      .select({
        id: messages.id,
        providerMessageId: messages.providerMessageId,
        senderEmail: messages.senderEmail,
        recipientsJson: messages.recipientsJson,
        copiedRecipientsJson: messages.copiedRecipientsJson,
        subject: messages.subject,
        textBody: messages.textBody,
        receivedAt: messages.receivedAt,
        contentHash: messages.contentHash,
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
      .select({ email: memberships.userEmail })
      .from(memberships)
      .where(
        and(
          eq(memberships.tenantId, context.tenantId),
          eq(memberships.status, "active"),
        ),
      ),
  ]);

  if (!settings || tenantMessages.length === 0) {
    throw new ConflictError("The imported thread or tenant settings are incomplete.");
  }
  if (tenantMessages.some((message) => message.textBody === REDACTED_EMAIL_CONTENT)) {
    throw new ConflictError("This thread can no longer be analysed because retained content was removed.");
  }

  const messageIds = tenantMessages.map((message) => message.id);
  const attachmentRows = messageIds.length
    ? await db
        .select({
          messageId: attachments.messageId,
          filename: attachments.filename,
          mimeType: attachments.mimeType,
        })
        .from(attachments)
        .where(
          and(
            eq(attachments.tenantId, context.tenantId),
            inArray(attachments.messageId, messageIds),
          ),
        )
    : [];
  const attachmentsByMessage = new Map<string, typeof attachmentRows>();
  for (const row of attachmentRows) {
    const existing = attachmentsByMessage.get(row.messageId) ?? [];
    existing.push(row);
    attachmentsByMessage.set(row.messageId, existing);
  }

  const analysisKey = await sha256Hex(
    JSON.stringify({
      tenantId: context.tenantId,
      targetMessageId: messageId,
      thread: tenantMessages.map((message) => [message.providerMessageId, message.contentHash]),
      settingsVersion: settings.version,
      promptVersion: EMAIL_ANALYSIS_PROMPT_VERSION,
    }),
  );
  const [existing] = await db
    .select()
    .from(messageAnalyses)
    .where(
      and(
        eq(messageAnalyses.tenantId, context.tenantId),
        eq(messageAnalyses.analysisKey, analysisKey),
      ),
    )
    .limit(1);
  if (existing) {
    const draft = existing.replyRequired && existing.suggestedReply
      ? await createDraftProposal({
          context,
          messageId,
          body: existing.suggestedReply,
          sourceAnalysisId: existing.id,
          authorType: "assistant",
        })
      : undefined;
    return { analysis: existing, draft, replayed: true };
  }

  const [latest] = await db
    .select({ version: messageAnalyses.version })
    .from(messageAnalyses)
    .where(
      and(
        eq(messageAnalyses.tenantId, context.tenantId),
        eq(messageAnalyses.messageId, messageId),
      ),
    )
    .orderBy(desc(messageAnalyses.version))
    .limit(1);
  const now = new Date();
  await db
    .update(messages)
    .set({ ingestionStatus: "analysing", updatedAt: now })
    .where(and(eq(messages.id, messageId), eq(messages.tenantId, context.tenantId)));

  try {
    const analysis = await analysisClient.analyzeEmailThread({
      trustedApplicationData: {
        targetMessageId: messageId,
        analysisDate: now.toISOString(),
        threadIsComplete: true,
      },
      tenantBusinessConfiguration: {
        businessName: context.tenantName,
        businessTimezone: settings.businessTimezone,
        replyTone: "Professional, concise, and transparent",
        replyGuidelines: settings.businessInstructions
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 50),
        approvedBusinessFacts: [],
        availableAssignees: activeMembers.map((member) => member.email).slice(0, 100),
      },
      thread: tenantMessages.map((message) => ({
        messageId: message.providerMessageId,
        direction:
          message.senderEmail.toLowerCase() === target.mailboxAddress.toLowerCase()
            ? ("outbound" as const)
            : ("inbound" as const),
        from: message.senderEmail,
        to: parseStringArray(message.recipientsJson),
        cc: parseStringArray(message.copiedRecipientsJson),
        sentAt: message.receivedAt.toISOString(),
        subject: message.subject,
        bodyText: message.textBody,
        attachments: (attachmentsByMessage.get(message.id) ?? []).map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          extractedText: null,
        })),
      })),
    });

    const analysisId = crypto.randomUUID();
    const version = (latest?.version ?? 0) + 1;
    const requiresReview =
      analysis.approvalRequired ||
      analysis.riskFlags.length > 0 ||
      analysis.confidenceScore < settings.minimumConfidence;
    await db.batch([
      db.insert(messageAnalyses).values({
        id: analysisId,
        tenantId: context.tenantId,
        messageId,
        analysisKey,
        version,
        primaryCategory: analysis.primaryCategory,
        secondaryCategoriesJson: JSON.stringify(analysis.secondaryCategories),
        priority: analysis.priority,
        sentiment: "not_assessed",
        senderIntent: analysis.senderIntent,
        summary: analysis.summary,
        factsJson: "[]",
        inferencesJson: "[]",
        missingInformationJson: "[]",
        entitiesJson: "[]",
        requiredActionsJson: JSON.stringify(analysis.requiredActions),
        detectedDatesJson: JSON.stringify(analysis.detectedDates),
        detectedDeadlinesJson: JSON.stringify(analysis.detectedDeadlines),
        detectedFinancialAmountsJson: JSON.stringify(analysis.detectedFinancialAmounts),
        riskFlagsJson: JSON.stringify(analysis.riskFlags),
        confidenceScore: analysis.confidenceScore,
        recommendedAssignee: analysis.recommendedAssignee,
        replyRequired: analysis.replyRequired,
        approvalRequired: true,
        suggestedReply: analysis.suggestedReply ?? "",
        suggestedNextAction: analysis.suggestedNextAction,
        reviewRequired: true,
        automationEligibilityJson: JSON.stringify({
          localDraftProposal: analysis.replyRequired && Boolean(analysis.suggestedReply),
          gmailDraftCreation: false,
          send: false,
        }),
        auditReason: requiresReview
          ? "Human review is required before any Gmail draft can be created."
          : "The MVP requires human review for every Gmail draft regardless of model confidence.",
        modelReference: aiConfig.enabled ? aiConfig.model : undefined,
        promptVersion: EMAIL_ANALYSIS_PROMPT_VERSION,
        createdAt: now,
      }),
      db
        .update(messages)
        .set({ ingestionStatus: "review", updatedAt: now })
        .where(and(eq(messages.id, messageId), eq(messages.tenantId, context.tenantId))),
    ]);

    const draft = analysis.suggestedReply
      ? await createDraftProposal({
          context,
          messageId,
          body: analysis.suggestedReply,
          sourceAnalysisId: analysisId,
          authorType: "assistant",
        })
      : undefined;

    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "assistant",
        actorId: "openai-analysis",
        eventType: "message.classified",
        action: "analyse_message_thread",
        targetType: "message_analysis",
        targetId: analysisId,
        messageId,
        threadId: target.threadId,
        result: "success",
        confidenceScore: analysis.confidenceScore,
        idempotencyKey: `audit:${analysisKey}`,
        metadata: { version, promptVersion: EMAIL_ANALYSIS_PROMPT_VERSION },
      },
      db,
    );

    return { analysis: { id: analysisId, ...analysis }, draft, replayed: false };
  } catch (error) {
    await db
      .update(messages)
      .set({ ingestionStatus: "review", updatedAt: new Date() })
      .where(and(eq(messages.id, messageId), eq(messages.tenantId, context.tenantId)));
    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "assistant",
        actorId: "openai-analysis",
        eventType: "message.classification_failed",
        action: "analyse_message_thread",
        targetType: "message",
        targetId: messageId,
        messageId,
        threadId: target.threadId,
        result: "failure",
        metadata: {
          errorCode:
            error instanceof OpenAIAnalysisError ? error.code : "AI_ANALYSIS_INTERNAL_ERROR",
        },
      },
      db,
    );
    throw error;
  }
}
