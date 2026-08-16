export type OperatingMode = "safe" | "draft";

export type PolicyAction = "propose_draft" | "create_gmail_draft";

export type PolicyInput = {
  mode: OperatingMode;
  action: PolicyAction;
  category: string;
  priority: "critical" | "high" | "normal" | "low";
  confidence: number;
  minimumConfidence: number;
  riskFlags: string[];
  capabilityEnabled: boolean;
  /** Must come from a database-backed approval lookup, never a request body. */
  approvalVerifiedByServer: boolean;
};

export type PolicyDecision = {
  eligible: boolean;
  approvalRequired: boolean;
  externallyVisible: false;
  reasonCode:
    | "ALLOWED"
    | "CAPABILITY_DISABLED"
    | "LOW_CONFIDENCE"
    | "REVIEW_REQUIRED"
    | "SERVER_APPROVAL_REQUIRED";
  auditReason: string;
};

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  if (!input.capabilityEnabled) {
    return {
      eligible: false,
      approvalRequired: input.action === "create_gmail_draft",
      externallyVisible: false,
      reasonCode: "CAPABILITY_DISABLED",
      auditReason: `${input.action} is disabled by the active tenant capability settings.`,
    };
  }

  if (input.action === "create_gmail_draft") {
    return input.approvalVerifiedByServer
      ? {
          eligible: true,
          approvalRequired: true,
          externallyVisible: false,
          reasonCode: "ALLOWED",
          auditReason: "The exact current draft version has a valid server-recorded approval.",
        }
      : {
          eligible: false,
          approvalRequired: true,
          externallyVisible: false,
          reasonCode: "SERVER_APPROVAL_REQUIRED",
          auditReason: "A valid database-backed approval for the exact draft version is required.",
        };
  }

  if (input.confidence < input.minimumConfidence) {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible: false,
      reasonCode: "LOW_CONFIDENCE",
      auditReason: "Classification confidence is below the tenant threshold; human review is required.",
    };
  }

  if (input.priority === "critical" || input.riskFlags.length > 0) {
    return {
      eligible: true,
      approvalRequired: true,
      externallyVisible: false,
      reasonCode: "REVIEW_REQUIRED",
      auditReason: "A local proposal may be prepared, but critical or risk-flagged content requires review.",
    };
  }

  return {
    eligible: true,
    approvalRequired: true,
    externallyVisible: false,
    reasonCode: "ALLOWED",
    auditReason:
      input.mode === "safe"
        ? "Safe Mode permits a local proposal; a human must approve before Gmail draft creation."
        : "Draft Mode permits a local proposal; no email can be sent by this application.",
  };
}

