export type OperatingMode = "safe" | "draft" | "assisted" | "autonomous";

export type PolicyAction =
  | "draft"
  | "label"
  | "reply"
  | "forward"
  | "archive"
  | "delete";

export type PolicyInput = {
  mode: OperatingMode;
  action: PolicyAction;
  category: string;
  priority: "critical" | "high" | "normal" | "low";
  confidence: number;
  minimumConfidence: number;
  riskFlags: string[];
  isNewContact: boolean;
  approvalRecorded: boolean;
  capabilityEnabled: boolean;
};

export type PolicyDecision = {
  eligible: boolean;
  approvalRequired: boolean;
  externallyVisible: boolean;
  reasonCode:
    | "ALLOWED"
    | "CAPABILITY_DISABLED"
    | "LOW_CONFIDENCE"
    | "SAFE_MODE_EXTERNAL_ACTION"
    | "DRAFT_MODE_EXTERNAL_ACTION"
    | "PROHIBITED_CATEGORY"
    | "RISK_REVIEW_REQUIRED"
    | "NEW_CONTACT_APPROVAL_REQUIRED";
  auditReason: string;
};

const externalActions = new Set<PolicyAction>(["reply", "forward"]);

const prohibitedCategoryTerms = [
  "legal",
  "security",
  "privacy",
  "data protection",
  "refund",
  "complaint",
  "payment detail",
  "contract",
  "employment",
  "regulatory",
];

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const externallyVisible = externalActions.has(input.action);

  if (!input.capabilityEnabled) {
    return {
      eligible: false,
      approvalRequired: false,
      externallyVisible,
      reasonCode: "CAPABILITY_DISABLED",
      auditReason: `${input.action} is disabled by the active tenant capability settings.`,
    };
  }

  if (input.confidence < input.minimumConfidence) {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "LOW_CONFIDENCE",
      auditReason: "Classification confidence is below the tenant threshold; review is required.",
    };
  }

  const normalizedCategory = input.category.toLowerCase();
  const isProhibitedCategory = prohibitedCategoryTerms.some((term) =>
    normalizedCategory.includes(term),
  );

  if (externallyVisible && isProhibitedCategory) {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "PROHIBITED_CATEGORY",
      auditReason: "The category requires specialist review and cannot be sent automatically.",
    };
  }

  if (externallyVisible && (input.priority === "critical" || input.riskFlags.length > 0)) {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "RISK_REVIEW_REQUIRED",
      auditReason: "Critical priority or a detected risk flag requires human review.",
    };
  }

  if (externallyVisible && input.mode === "safe") {
    return {
      eligible: input.approvalRecorded,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "SAFE_MODE_EXTERNAL_ACTION",
      auditReason: input.approvalRecorded
        ? "Safe Mode permits this exact approved action for guarded execution."
        : "Safe Mode requires approval for every externally visible action.",
    };
  }

  if (externallyVisible && input.mode === "draft") {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "DRAFT_MODE_EXTERNAL_ACTION",
      auditReason: "Draft Mode never performs externally visible actions.",
    };
  }

  if (externallyVisible && input.isNewContact && !input.approvalRecorded) {
    return {
      eligible: false,
      approvalRequired: true,
      externallyVisible,
      reasonCode: "NEW_CONTACT_APPROVAL_REQUIRED",
      auditReason: "The sender is a new contact and no approval is recorded.",
    };
  }

  return {
    eligible: true,
    approvalRequired: externallyVisible && !input.approvalRecorded,
    externallyVisible,
    reasonCode: "ALLOWED",
    auditReason: "The action is enabled and passes the active policy checks.",
  };
}
