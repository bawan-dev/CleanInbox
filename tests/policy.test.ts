import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, type PolicyInput } from "../lib/policy";

const safeReply: PolicyInput = {
  mode: "safe",
  action: "reply",
  category: "Customer support",
  priority: "normal",
  confidence: 96,
  minimumConfidence: 85,
  riskFlags: [],
  isNewContact: false,
  approvalRecorded: false,
  capabilityEnabled: true,
};

test("Safe Mode requires approval for external replies", () => {
  const decision = evaluatePolicy(safeReply);
  assert.equal(decision.eligible, false);
  assert.equal(decision.approvalRequired, true);
  assert.equal(decision.reasonCode, "SAFE_MODE_EXTERNAL_ACTION");
});

test("Safe Mode permits the exact approved low-risk reply", () => {
  const decision = evaluatePolicy({ ...safeReply, approvalRecorded: true });
  assert.equal(decision.eligible, true);
  assert.equal(decision.approvalRequired, true);
});

test("prohibited categories stay blocked even with approval", () => {
  const decision = evaluatePolicy({
    ...safeReply,
    category: "Security incident",
    priority: "critical",
    riskFlags: ["Account compromise"],
    approvalRecorded: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "PROHIBITED_CATEGORY");
});

test("below-threshold confidence fails closed", () => {
  const decision = evaluatePolicy({
    ...safeReply,
    action: "draft",
    confidence: 84,
    capabilityEnabled: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "LOW_CONFIDENCE");
});

test("internal low-risk drafting is eligible when enabled", () => {
  const decision = evaluatePolicy({
    ...safeReply,
    action: "draft",
    capabilityEnabled: true,
  });
  assert.equal(decision.eligible, true);
  assert.equal(decision.externallyVisible, false);
});

test("disabled capabilities cannot be bypassed by mode or approval", () => {
  const decision = evaluatePolicy({
    ...safeReply,
    mode: "autonomous",
    approvalRecorded: true,
    capabilityEnabled: false,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "CAPABILITY_DISABLED");
});

test("new contacts require approval in assisted mode", () => {
  const decision = evaluatePolicy({
    ...safeReply,
    mode: "assisted",
    isNewContact: true,
  });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "NEW_CONTACT_APPROVAL_REQUIRED");
});
