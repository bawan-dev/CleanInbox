import assert from "node:assert/strict";
import test from "node:test";
import { retentionDeadline } from "../lib/retention-policy";

test("retention deadline is deterministic and bounded", () => {
  const received = new Date("2026-08-01T12:00:00.000Z");
  assert.equal(retentionDeadline(received, 30).toISOString(), "2026-08-31T12:00:00.000Z");
  assert.throws(() => retentionDeadline(received, 0), /between 1 and 365/i);
  assert.throws(() => retentionDeadline(received, 366), /between 1 and 365/i);
});
