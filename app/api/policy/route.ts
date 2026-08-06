import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { tenantSettings } from "@/db/schema";
import { evaluatePolicy, type PolicyAction } from "@/lib/policy";
import { jsonError, resolveTenantContext } from "@/lib/tenant-context";

type PolicyRequest = {
  action?: PolicyAction;
  category?: string;
  priority?: "critical" | "high" | "normal" | "low";
  confidence?: number;
  riskFlags?: string[];
  isNewContact?: boolean;
  approvalRecorded?: boolean;
};

const policyActions = new Set<PolicyAction>([
  "draft",
  "label",
  "reply",
  "forward",
  "archive",
  "delete",
]);

export async function POST(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const body = (await request.json()) as PolicyRequest;

    if (
      !body.action ||
      !policyActions.has(body.action) ||
      !body.category ||
      !body.priority ||
      typeof body.confidence !== "number"
    ) {
      return Response.json({ error: "A valid action and message assessment are required." }, { status: 400 });
    }

    const [settings] = await getDb()
      .select()
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .limit(1);

    const safeSettings = settings ?? {
      operatingMode: "safe" as const,
      minimumClassificationConfidence: 85,
      autoDraft: true,
      autoLabel: true,
      autoSend: false,
      autoArchive: false,
      autoForward: false,
      autoDelete: false,
    };

    const capabilityEnabled = {
      draft: safeSettings.autoDraft,
      label: safeSettings.autoLabel,
      reply: safeSettings.autoSend,
      forward: safeSettings.autoForward,
      archive: safeSettings.autoArchive,
      delete: safeSettings.autoDelete,
    }[body.action];

    const decision = evaluatePolicy({
      mode: safeSettings.operatingMode,
      action: body.action,
      category: body.category,
      priority: body.priority,
      confidence: body.confidence,
      minimumConfidence: safeSettings.minimumClassificationConfidence,
      riskFlags: Array.isArray(body.riskFlags) ? body.riskFlags : [],
      isNewContact: Boolean(body.isNewContact),
      approvalRecorded: Boolean(body.approvalRecorded),
      capabilityEnabled,
    });

    return Response.json({ decision });
  } catch (error) {
    return jsonError(error);
  }
}
