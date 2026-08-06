export type Priority = "critical" | "high" | "normal" | "low";

export type MessageStatus =
  | "needs-review"
  | "draft-ready"
  | "waiting"
  | "escalated"
  | "resolved";

export type RiskLevel = "none" | "review" | "blocked";

export type Attachment = {
  name: string;
  type: string;
  size: string;
  risk: "safe" | "review" | "quarantined";
};

export type ExtractedItem = {
  label: string;
  value: string;
  verified?: boolean;
};

export type ThreadEntry = {
  id: string;
  sender: string;
  email: string;
  timestamp: string;
  body: string[];
  direction: "inbound" | "outbound";
};

export type InboxMessage = {
  id: string;
  threadId: string;
  sender: string;
  initials: string;
  email: string;
  company: string;
  subject: string;
  preview: string;
  receivedAt: string;
  timestamp: string;
  unread: boolean;
  priority: Priority;
  category: string;
  secondaryCategories: string[];
  sentiment: string;
  status: MessageStatus;
  confidence: number;
  relationship: string;
  summary: string;
  intent: string;
  nextAction: string;
  assignee: string;
  labels: string[];
  riskLevel: RiskLevel;
  riskFlags: string[];
  facts: string[];
  missingInformation: string[];
  extracted: ExtractedItem[];
  requiredActions: string[];
  attachments: Attachment[];
  thread: ThreadEntry[];
  draft?: {
    subject: string;
    body: string[];
    signature: string;
  };
  auditReason: string;
};

export type AuditEvent = {
  id: string;
  action: string;
  detail: string;
  actor: string;
  time: string;
  tone: "neutral" | "success" | "warning" | "danger";
};
