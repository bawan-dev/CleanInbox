import assert from "node:assert/strict";
import test from "node:test";
import { evaluatePolicy, type PolicyInput } from "../lib/policy";

const proposal: PolicyInput = {
  mode: "safe",
  action: "propose_draft",
  category: "customer support",
  priority: "normal",
  confidence: 93,
  minimumConfidence: 85,
  riskFlags: [],
  capabilityEnabled: true,
  approvalVerifiedByServer: false,
};

test("Safe Mode permits a local proposal but always records approval as required", () => {
  const decision = evaluatePolicy(proposal);
  assert.equal(decision.eligible, true);
  assert.equal(decision.approvalRequired, true);
  assert.equal(decision.externallyVisible, false);
});

test("critical and risk-flagged content stays review-required", () => {
  const decision = evaluatePolicy({ ...proposal, priority: "critical", riskFlags: ["security"] });
  assert.equal(decision.eligible, true);
  assert.equal(decision.approvalRequired, true);
  assert.equal(decision.reasonCode, "REVIEW_REQUIRED");
});

test("below-threshold confidence fails closed", () => {
  const decision = evaluatePolicy({ ...proposal, confidence: 84 });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "LOW_CONFIDENCE");
});

test("disabled proposal generation cannot be bypassed", () => {
  const decision = evaluatePolicy({ ...proposal, capabilityEnabled: false });
  assert.equal(decision.eligible, false);
  assert.equal(decision.reasonCode, "CAPABILITY_DISABLED");
});

test("Gmail draft creation requires a server-verified exact-version approval", () => {
  const blocked = evaluatePolicy({
    ...proposal,
    action: "create_gmail_draft",
    approvalVerifiedByServer: false,
  });
  const allowed = evaluatePolicy({
    ...proposal,
    action: "create_gmail_draft",
    approvalVerifiedByServer: true,
  });

  assert.equal(blocked.eligible, false);
  assert.equal(blocked.reasonCode, "SERVER_APPROVAL_REQUIRED");
  assert.equal(allowed.eligible, true);
  assert.equal(allowed.externallyVisible, false);
});

