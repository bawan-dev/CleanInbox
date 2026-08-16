import { and, desc, eq } from "drizzle-orm";
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

export async function computeAuditEventHash({
  tenantId,
  sequence,
  actorType,
  actorId,
  eventType,
  action,
  targetType,
  targetId,
  result,
  createdAt,
  status,
  previousEventHash,
  metadata,
}: {
  tenantId: string;
  sequence: number;
  actorType: string;
  actorId?: string | null;
  eventType: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  result: string;
  createdAt: string | number | Date;
  status?: string;
  previousEventHash?: string | null;
  metadata?: Record<string, JsonValue>;
}): Promise<string> {
  const safeMetadata = sanitizeValue((metadata ?? {}) as Record<string, JsonValue>);
  const hashMaterial = stableJson({
    tenantId,
    sequence,
    actorType,
    actorId: actorId ?? null,
    eventType,
    action,
    targetType,
    targetId: targetId ?? null,
    result,
    status: status ?? result,
    createdAt: new Date(createdAt).getTime(),
    previousEventHash: previousEventHash ?? null,
    metadata: safeMetadata,
  });
  return sha256Hex(hashMaterial);
}

export async function validateAuditHistory(
  events: Array<{
    tenantId: string;
    sequence: number;
    actorType: string;
    actorId?: string | null;
    eventType: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    result: string;
    status?: string;
    previousEventHash?: string | null;
    eventHash: string;
    createdAt: string | number | Date;
    metadata?: Record<string, JsonValue>;
  }>,
): Promise<boolean> {
  if (events.length === 0) return true;

  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  let previousEventHash: string | null = null;

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    if (!Number.isInteger(current.sequence) || current.sequence !== index + 1) {
      return false;
    }
    if (current.previousEventHash !== previousEventHash) {
      return false;
    }
    const expectedHash = await computeAuditEventHash({
      tenantId: current.tenantId,
      sequence: current.sequence,
      actorType: current.actorType,
      actorId: current.actorId,
      eventType: current.eventType,
      action: current.action,
      targetType: current.targetType,
      targetId: current.targetId,
      result: current.result,
      createdAt: current.createdAt,
      status: current.status,
      previousEventHash: previousEventHash,
      metadata: current.metadata,
    });
    if (current.eventHash !== expectedHash) {
      return false;
    }
    previousEventHash = current.eventHash;
  }

  return true;
}

export async function appendAuditEvent(
  input: AuditInput,
  db?: Awaited<ReturnType<typeof import("@/db").getDb>>,
) {
  const resolvedDb = db ?? (await import("@/db")).getDb();
  if (input.idempotencyKey) {
    const [existing] = await resolvedDb
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

  const createdAt = new Date();
  const safeMetadata = sanitizeValue(input.metadata ?? {}) as Record<string, JsonValue>;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await resolvedDb.transaction(async (tx) => {
        const [previous] = await tx
          .select({
            sequence: auditEvents.sequence,
            eventHash: auditEvents.eventHash,
          })
          .from(auditEvents)
          .where(eq(auditEvents.tenantId, input.tenantId))
          .orderBy(desc(auditEvents.sequence))
          .limit(1);

        const sequence = (previous?.sequence ?? 0) + 1;
        const hash = await computeAuditEventHash({
          tenantId: input.tenantId,
          sequence,
          actorType: input.actorType,
          actorId: input.actorId ?? null,
          eventType: input.eventType,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId ?? null,
          result: input.result,
          createdAt,
          status: input.status ?? input.result,
          previousEventHash: previous?.eventHash ?? null,
          metadata: safeMetadata,
        });

        const id = crypto.randomUUID();
        const values = {
          id,
          tenantId: input.tenantId,
          sequence,
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
          previousEventHash: previous?.eventHash ?? null,
          eventHash: hash,
          createdAt,
        } satisfies typeof auditEvents.$inferInsert;

        const [created] = await tx.insert(auditEvents).values(values).returning();
        return created;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/SQLITE_CONSTRAINT|UNIQUE/i.test(message) || attempt === 5) {
        if (input.idempotencyKey) {
          const [replayed] = await resolvedDb
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
  }

  throw new Error("Failed to append audit event after concurrent sequence retries.");
}
