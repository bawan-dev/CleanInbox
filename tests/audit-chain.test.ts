import assert from "node:assert/strict";
import test from "node:test";

import {
  computeAuditEventHash,
  validateAuditHistory,
} from "../lib/audit";

test("concurrent audit appends retain a deterministic tenant chain", async () => {
  const entries = Array.from({ length: 18 }, (_, index) => {
    const eventType = index % 3 === 0 ? "sync" : index % 3 === 1 ? "approval" : "retention";
    const metadata = { index, eventType, actor: `worker-${index % 5}` };
    return {
      tenantId: "tenant-42",
      sequence: index + 1,
      actorType: "system",
      eventType,
      metadata,
      createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
      result: "success",
      actorId: `actor-${index % 3}`,
      action: "audit",
      targetType: "message",
      targetId: `message-${index}`,
      status: "success",
    };
  });

  let previousEventHash: string | null = null;
  const hashed = [] as Array<{
    tenantId: string;
    sequence: number;
    actorType: string;
    eventType: string;
    metadata: Record<string, string | number | boolean | null>;
    createdAt: string;
    result: string;
    actorId: string;
    action: string;
    targetType: string;
    targetId: string;
    status: string;
    previousEventHash: string | null;
    eventHash: string;
  }>;

  for (const entry of entries) {
    const eventHash = await computeAuditEventHash({
      tenantId: entry.tenantId,
      sequence: entry.sequence,
      actorType: entry.actorType,
      eventType: entry.eventType,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      result: entry.result,
      createdAt: entry.createdAt,
      status: entry.status,
      actorId: entry.actorId,
      previousEventHash,
      metadata: entry.metadata,
    });

    hashed.push({
      ...entry,
      previousEventHash,
      eventHash,
    });
    previousEventHash = eventHash;
  }

  const shuffled = [
    hashed[9], hashed[3], hashed[15], hashed[0], hashed[6], hashed[12], hashed[1], hashed[8],
    hashed[5], hashed[13], hashed[2], hashed[17], hashed[4], hashed[10], hashed[11], hashed[14],
    hashed[7], hashed[16],
  ];

  const tampered = [...shuffled];
  tampered[0] = { ...tampered[0], previousEventHash: "tampered-link" };
  assert.equal(await validateAuditHistory(tampered), false);

  const ordered = [...shuffled].sort((left, right) => left.sequence - right.sequence);
  const validated = await validateAuditHistory(ordered);
  assert.equal(validated, true);
  assert.deepEqual(
    ordered.map((entry) => entry.sequence),
    Array.from({ length: ordered.length }, (_, index) => index + 1),
  );
});
