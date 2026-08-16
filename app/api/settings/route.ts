import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { tenantSettings } from "@/db/schema";
import { appendAuditEvent } from "@/lib/audit";
import { jsonError, requireRole, resolveTenantContext } from "@/lib/tenant-context";

const updateSettingsSchema = z
  .object({
    minimumClassificationConfidence: z.number().int().min(50).max(100).optional(),
    initialSyncLimit: z.number().int().min(1).max(100).optional(),
    contentRetentionDays: z.number().int().min(1).max(365).optional(),
    retainDraftAfterGmailCreation: z.boolean().optional(),
    businessTimezone: z.string().trim().min(1).max(80).optional(),
    businessInstructions: z.string().trim().max(4_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "At least one setting is required.");

const safeColumns = {
  operatingMode: tenantSettings.operatingMode,
  minimumClassificationConfidence: tenantSettings.minimumClassificationConfidence,
  initialSyncLimit: tenantSettings.initialSyncLimit,
  contentRetentionDays: tenantSettings.contentRetentionDays,
  attachmentsEnabled: tenantSettings.attachmentsEnabled,
  retainDraftAfterGmailCreation: tenantSettings.retainDraftAfterGmailCreation,
  businessTimezone: tenantSettings.businessTimezone,
  businessInstructions: tenantSettings.businessInstructions,
  version: tenantSettings.version,
  updatedAt: tenantSettings.updatedAt,
};

export async function GET(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    const [settings] = await getDb()
      .select(safeColumns)
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .limit(1);

    if (!settings) {
      return Response.json({ error: "Organisation settings were not found." }, { status: 404 });
    }
    return Response.json({ settings });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PUT(request: Request) {
  try {
    const context = await resolveTenantContext(request.headers);
    requireRole(context, ["owner"]);
    const parsed = updateSettingsSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json({ error: "Settings are invalid or outside safe limits." }, { status: 400 });
    }

    const db = getDb();
    const [before] = await db
      .select(safeColumns)
      .from(tenantSettings)
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .limit(1);
    if (!before) {
      return Response.json({ error: "Organisation settings were not found." }, { status: 404 });
    }

    const now = new Date();
    const [updated] = await db
      .update(tenantSettings)
      .set({
        ...parsed.data,
        // Provider mutations outside Gmail draft creation remain impossible in this MVP.
        operatingMode: "safe",
        autoLabel: false,
        autoSend: false,
        autoArchive: false,
        autoForward: false,
        autoDelete: false,
        attachmentsEnabled: false,
        version: before.version + 1,
        updatedAt: now,
      })
      .where(eq(tenantSettings.tenantId, context.tenantId))
      .returning(safeColumns);

    const retentionChanged =
      parsed.data.contentRetentionDays !== undefined &&
      parsed.data.contentRetentionDays !== before.contentRetentionDays;
    await appendAuditEvent(
      {
        tenantId: context.tenantId,
        actorType: "user",
        actorId: context.userId,
        eventType: retentionChanged ? "retention.changed" : "policy.changed",
        action: "update_settings",
        targetType: "tenant_settings",
        targetId: context.tenantId,
        result: "success",
        metadata: {
          changedFields: Object.keys(parsed.data),
          version: updated.version,
        },
      },
      db,
    );

    return Response.json({ settings: updated });
  } catch (error) {
    return jsonError(error);
  }
}

