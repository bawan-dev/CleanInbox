import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
};

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("tenants_slug_unique").on(table.slug)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    role: text("role", { enum: ["admin", "approver", "operator", "viewer"] })
      .notNull()
      .default("viewer"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("memberships_tenant_email_unique").on(table.tenantId, table.userEmail),
    index("memberships_email_idx").on(table.userEmail),
  ],
);

export const tenantSettings = sqliteTable(
  "tenant_settings",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    operatingMode: text("operating_mode", {
      enum: ["safe", "draft", "assisted", "autonomous"],
    })
      .notNull()
      .default("safe"),
    minimumClassificationConfidence: integer("minimum_classification_confidence")
      .notNull()
      .default(85),
    autoDraft: integer("auto_draft", { mode: "boolean" }).notNull().default(true),
    autoLabel: integer("auto_label", { mode: "boolean" }).notNull().default(true),
    autoSend: integer("auto_send", { mode: "boolean" }).notNull().default(false),
    autoArchive: integer("auto_archive", { mode: "boolean" }).notNull().default(false),
    autoForward: integer("auto_forward", { mode: "boolean" }).notNull().default(false),
    autoDelete: integer("auto_delete", { mode: "boolean" }).notNull().default(false),
    requireApprovalBeforeSend: integer("require_approval_before_send", { mode: "boolean" })
      .notNull()
      .default(true),
    requireApprovalForNewContacts: integer("require_approval_for_new_contacts", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    requireApprovalForFinancial: integer("require_approval_for_financial", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    requireApprovalForLegal: integer("require_approval_for_legal", { mode: "boolean" })
      .notNull()
      .default(true),
    requireApprovalForComplaints: integer("require_approval_for_complaints", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    requireApprovalForRefunds: integer("require_approval_for_refunds", { mode: "boolean" })
      .notNull()
      .default(true),
    auditLogEnabled: integer("audit_log_enabled", { mode: "boolean" }).notNull().default(true),
    piiRedactionEnabled: integer("pii_redaction_enabled", { mode: "boolean" })
      .notNull()
      .default(true),
    version: integer("version").notNull().default(1),
    ...timestamps,
  },
  (table) => [uniqueIndex("tenant_settings_tenant_unique").on(table.tenantId)],
);

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerMailboxId: text("provider_mailbox_id").notNull(),
    address: text("address").notNull(),
    displayName: text("display_name"),
    status: text("status", { enum: ["active", "disconnected", "error"] })
      .notNull()
      .default("active"),
    credentialReference: text("credential_reference").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailboxes_tenant_provider_unique").on(
      table.tenantId,
      table.provider,
      table.providerMailboxId,
    ),
    index("mailboxes_tenant_idx").on(table.tenantId),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subject: text("subject").notNull(),
    status: text("status", {
      enum: ["open", "waiting", "escalated", "resolved", "archived"],
    })
      .notNull()
      .default("open"),
    assignedTo: text("assigned_to"),
    lastMessageAt: integer("last_message_at", { mode: "timestamp_ms" }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("threads_tenant_mailbox_provider_unique").on(
      table.tenantId,
      table.mailboxId,
      table.providerThreadId,
    ),
    index("threads_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    senderName: text("sender_name"),
    senderEmail: text("sender_email").notNull(),
    replyToEmail: text("reply_to_email"),
    recipientsJson: text("recipients_json").notNull(),
    copiedRecipientsJson: text("copied_recipients_json").notNull().default("[]"),
    subject: text("subject").notNull(),
    textBody: text("text_body").notNull(),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    contentHash: text("content_hash").notNull(),
    ingestionStatus: text("ingestion_status", {
      enum: ["received", "analysing", "analysed", "review", "failed"],
    })
      .notNull()
      .default("received"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("messages_tenant_mailbox_provider_unique").on(
      table.tenantId,
      table.mailboxId,
      table.providerMessageId,
    ),
    index("messages_tenant_thread_idx").on(table.tenantId, table.threadId),
    index("messages_tenant_received_idx").on(table.tenantId, table.receivedAt),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    providerAttachmentId: text("provider_attachment_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    riskLevel: text("risk_level", { enum: ["safe", "review", "quarantined"] })
      .notNull()
      .default("review"),
    extractionStatus: text("extraction_status", {
      enum: ["not_requested", "pending", "complete", "blocked", "failed"],
    })
      .notNull()
      .default("not_requested"),
    objectReference: text("object_reference"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("attachments_tenant_message_provider_unique").on(
      table.tenantId,
      table.messageId,
      table.providerAttachmentId,
    ),
    index("attachments_tenant_message_idx").on(table.tenantId, table.messageId),
  ],
);

export const messageAnalyses = sqliteTable(
  "message_analyses",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    primaryCategory: text("primary_category").notNull(),
    secondaryCategoriesJson: text("secondary_categories_json").notNull().default("[]"),
    priority: text("priority", { enum: ["critical", "high", "normal", "low", "ignore"] })
      .notNull(),
    sentiment: text("sentiment").notNull(),
    senderIntent: text("sender_intent").notNull(),
    summary: text("summary").notNull(),
    factsJson: text("facts_json").notNull().default("[]"),
    inferencesJson: text("inferences_json").notNull().default("[]"),
    missingInformationJson: text("missing_information_json").notNull().default("[]"),
    entitiesJson: text("entities_json").notNull().default("[]"),
    requiredActionsJson: text("required_actions_json").notNull().default("[]"),
    riskFlagsJson: text("risk_flags_json").notNull().default("[]"),
    confidenceScore: integer("confidence_score").notNull(),
    reviewRequired: integer("review_required", { mode: "boolean" }).notNull(),
    automationEligibilityJson: text("automation_eligibility_json").notNull(),
    auditReason: text("audit_reason").notNull(),
    modelReference: text("model_reference"),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("analyses_tenant_message_version_unique").on(
      table.tenantId,
      table.messageId,
      table.version,
    ),
    index("analyses_tenant_review_idx").on(table.tenantId, table.reviewRequired),
  ],
);

export const drafts = sqliteTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["proposed", "edited", "approved", "rejected", "executed", "superseded"],
    })
      .notNull()
      .default("proposed"),
    currentVersion: integer("current_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [index("drafts_tenant_status_idx").on(table.tenantId, table.status)],
);

export const draftVersions = sqliteTable(
  "draft_versions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    recipientsJson: text("recipients_json").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    contentHash: text("content_hash").notNull(),
    authorType: text("author_type", { enum: ["assistant", "human"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("draft_versions_tenant_draft_version_unique").on(
      table.tenantId,
      table.draftId,
      table.version,
    ),
  ],
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    draftVersionId: text("draft_version_id").references(() => draftVersions.id, {
      onDelete: "restrict",
    }),
    actionType: text("action_type").notNull(),
    actionHash: text("action_hash").notNull(),
    status: text("status", { enum: ["pending", "approved", "rejected", "expired"] })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (table) => [
    index("approval_requests_tenant_status_idx").on(table.tenantId, table.status),
    uniqueIndex("approval_requests_tenant_action_hash_unique").on(table.tenantId, table.actionHash),
  ],
);

export const actionExecutions = sqliteTable(
  "action_executions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    approvalRequestId: text("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "restrict",
    }),
    actionType: text("action_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["proposed", "attempting", "succeeded", "failed", "ambiguous", "cancelled"],
    })
      .notNull()
      .default("proposed"),
    providerResultReference: text("provider_result_reference"),
    errorCode: text("error_code"),
    attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("action_executions_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("action_executions_tenant_status_idx").on(table.tenantId, table.status),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    actorType: text("actor_type", { enum: ["system", "assistant", "user", "integration"] })
      .notNull(),
    actorId: text("actor_id"),
    eventType: text("event_type").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    approvalStatus: text("approval_status"),
    ruleReferencesJson: text("rule_references_json").notNull().default("[]"),
    confidenceScore: integer("confidence_score"),
    integrationResult: text("integration_result"),
    redactedDetailJson: text("redacted_detail_json").notNull().default("{}"),
    previousEventHash: text("previous_event_hash"),
    eventHash: text("event_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("audit_events_tenant_event_hash_unique").on(table.tenantId, table.eventHash),
    index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_events_tenant_message_idx").on(table.tenantId, table.messageId),
  ],
);
