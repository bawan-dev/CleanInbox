import { z } from "zod";

const shortText = z.string().min(1).max(200);
const conciseText = z.string().min(1).max(2_000);

/**
 * The only shape ClearInbox accepts from an email-analysis model.
 *
 * Every key is required, including nullable values. This is intentional: OpenAI
 * strict structured outputs require all object properties to be required, and a
 * second Zod parse remains the application trust boundary.
 */
export const emailAnalysisSchema = z
  .strictObject({
    primaryCategory: shortText,
    secondaryCategories: z.array(shortText).max(20),
    priority: z.enum(["critical", "high", "normal", "low", "ignore"]),
    senderIntent: conciseText,
    summary: conciseText,
    requiredActions: z.array(conciseText).max(50),
    detectedDates: z.array(shortText).max(50),
    detectedDeadlines: z.array(shortText).max(50),
    detectedFinancialAmounts: z.array(shortText).max(50),
    riskFlags: z.array(shortText).max(50),
    confidenceScore: z.number().int().min(0).max(100),
    recommendedAssignee: shortText.nullable(),
    replyRequired: z.boolean(),
    approvalRequired: z.boolean(),
    suggestedReply: z.string().min(1).max(12_000).nullable(),
    suggestedNextAction: conciseText,
  })
  .superRefine((analysis, context) => {
    if (analysis.replyRequired && analysis.suggestedReply === null) {
      context.addIssue({
        code: "custom",
        path: ["suggestedReply"],
        message: "A suggested reply is required when replyRequired is true.",
      });
    }

    if (!analysis.replyRequired && analysis.suggestedReply !== null) {
      context.addIssue({
        code: "custom",
        path: ["suggestedReply"],
        message: "A suggested reply must be null when replyRequired is false.",
      });
    }
  });

export type EmailAnalysis = z.infer<typeof emailAnalysisSchema>;

type JsonSchema = Record<string, unknown>;

function createStrictJsonSchema(): JsonSchema {
  const generated = z.toJSONSchema(emailAnalysisSchema, { target: "draft-7" });

  // The dialect marker is not part of the schema object expected by
  // Responses API text.format. The generated object still retains the strict
  // root `additionalProperties: false` and complete `required` list.
  const schema: JsonSchema = { ...generated };
  delete schema.$schema;
  return schema;
}

/** JSON Schema supplied to Responses API `text.format.schema`. */
export const EMAIL_ANALYSIS_JSON_SCHEMA = createStrictJsonSchema();
