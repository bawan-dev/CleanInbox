import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { tenantSettings } from "@/db/schema";
import { evaluatePolicy } from "@/lib/policy";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

const policyRequestSchema = z.object({
  action: z.literal("propose_draft"),
  category: z.string().trim().min(1).max(100),
  priority: z.enum(["critical", "high", "normal", "low"]),
  confidence: z.number().int().min(0).max(100),
  riskFlags: z.array(z.string().trim().min(1).max(100)).max(25).default([]),
}).strict();

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const parsed = policyRequestSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: "A valid local draft-proposal assessment is required." },
        { status: 400 },
      );
    }

    const [settings] = await getDb()
      .select({
        operatingMode: tenantSettings.operatingMode,
        minimumClassificationConfidence: tenantSettings.minimumClassificationConfidence,
        autoDraft: tenantSettings.autoDraft,
      })
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .limit(1);

    const decision = evaluatePolicy({
      mode: settings?.operatingMode === "draft" ? "draft" : "safe",
      action: "propose_draft",
      category: parsed.data.category,
      priority: parsed.data.priority,
      confidence: parsed.data.confidence,
      minimumConfidence: settings?.minimumClassificationConfidence ?? 85,
      riskFlags: parsed.data.riskFlags,
      capabilityEnabled: settings?.autoDraft ?? true,
      approvalVerifiedByServer: false,
    });

    return Response.json({ decision });
  } catch (error) {
    return jsonError(error);
  }
}

