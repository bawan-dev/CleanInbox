import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditEvents } from "@/db/schema";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AuditInput = {
  tenantId: string;
  actorType: "system" | "assistant" | "user" | "integration";
  actorId?: string;
  eventType: string;
  action: string;
  targetType: string;
  targetId?: string;
  result: "success" | "failure" | "denied" | "pending";
  status?: string;
  messageId?: string;
  threadId?: string;
  approvalStatus?: string;
  ruleReferences?: string[];
  confidenceScore?: number;
  integrationResult?: string;
  metadata?: Record<string, JsonValue>;
  requestId?: string;
  correlationId?: string;
  idempotencyKey?: string;
};

const sensitiveKey = /(authorization|cookie|secret|token|password|credential|emailbody|rawmessage|apikey)/i;

function sanitizeValue(value: JsonValue, depth = 0): JsonValue {
  if (depth > 4) {
    return "[TRUNCATED]";
  }

  if (typeof value === "string") {
    return value.length > 256 ? `${value.slice(0, 256)}…` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 25).map((entry) => sanitizeValue(entry, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .map(([key, entry]) => [
          key,
          sensitiveKey.test(key) ? "[REDACTED]" : sanitizeValue(entry, depth + 1),
        ]),
    );
  }

  return value;
}

function stableJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function appendAuditEvent(
  input: AuditInput,
  db: ReturnType<typeof getDb> = getDb(),
) {
  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, input.tenantId),
          eq(auditEvents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existing) {
      return existing;
    }
  }

  const [previous] = await db
    .select({ eventHash: auditEvents.eventHash })
    .from(auditEvents)
    .where(eq(auditEvents.tenantId, input.tenantId))
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);

  const id = crypto.randomUUID();
  const createdAt = new Date();
  const safeMetadata = sanitizeValue(input.metadata ?? {}) as Record<string, JsonValue>;
  const hashMaterial = stableJson({
    id,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    eventType: input.eventType,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    result: input.result,
    createdAt: createdAt.getTime(),
    previousEventHash: previous?.eventHash ?? null,
    metadata: safeMetadata,
  });
  const eventHash = await sha256Hex(hashMaterial);

  const values = {
      id,
      tenantId: input.tenantId,
      messageId: input.messageId,
      threadId: input.threadId,
      actorType: input.actorType,
      actorId: input.actorId,
      eventType: input.eventType,
      action: input.action,
      status: input.status ?? input.result,
      targetType: input.targetType,
      targetId: input.targetId,
      result: input.result,
      requestId: input.requestId,
      correlationId: input.correlationId,
      idempotencyKey: input.idempotencyKey,
      approvalStatus: input.approvalStatus,
      ruleReferencesJson: JSON.stringify(input.ruleReferences ?? []),
      confidenceScore: input.confidenceScore,
      integrationResult: input.integrationResult,
      redactedDetailJson: JSON.stringify(safeMetadata),
      previousEventHash: previous?.eventHash,
      eventHash,
      createdAt,
    } satisfies typeof auditEvents.$inferInsert;

  try {
    const [created] = await db.insert(auditEvents).values(values).returning();
    return created;
  } catch (error) {
    if (input.idempotencyKey) {
      const [replayed] = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, input.tenantId),
            eq(auditEvents.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (replayed) return replayed;
    }
    throw error;
  }
}
