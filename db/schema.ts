import { sql } from "drizzle-orm";
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

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    lastSignedInAt: integer("last_signed_in_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    role: text("role", {
      enum: ["owner", "reviewer", "admin", "approver", "operator", "viewer"],
    })
      .notNull()
      .default("reviewer"),
    status: text("status", { enum: ["active", "disabled"] }).notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("memberships_tenant_email_unique").on(table.tenantId, table.userEmail),
    uniqueIndex("memberships_email_unique").on(table.userEmail),
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
    autoLabel: integer("auto_label", { mode: "boolean" }).notNull().default(false),
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
    initialSyncLimit: integer("initial_sync_limit").notNull().default(25),
    contentRetentionDays: integer("content_retention_days").notNull().default(30),
    attachmentsEnabled: integer("attachments_enabled", { mode: "boolean" })
      .notNull()
      .default(false),
    retainDraftAfterGmailCreation: integer("retain_draft_after_gmail_creation", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    businessTimezone: text("business_timezone").notNull().default("UTC"),
    businessInstructions: text("business_instructions").notNull().default(""),
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
    providerAccountId: text("provider_account_id").notNull(),
    address: text("address").notNull(),
    displayName: text("display_name"),
    status: text("status", { enum: ["active", "disconnected", "error"] })
      .notNull()
      .default("active"),
    credentialReference: text("credential_reference"),
    grantedScopesJson: text("granted_scopes_json").notNull().default("[]"),
    tokenExpiresAt: integer("token_expires_at", { mode: "timestamp_ms" }),
    lastSuccessfulSyncAt: integer("last_successful_sync_at", { mode: "timestamp_ms" }),
    lastHistoryId: text("last_history_id"),
    connectionErrorCode: text("connection_error_code"),
    disconnectedAt: integer("disconnected_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailboxes_tenant_provider_unique").on(
      table.tenantId,
      table.provider,
      table.providerMailboxId,
    ),
    uniqueIndex("mailboxes_provider_account_unique").on(
      table.provider,
      table.providerAccountId,
    ),
    uniqueIndex("mailboxes_tenant_active_provider_unique")
      .on(table.tenantId, table.provider)
      .where(sql`${table.status} = 'active'`),
    index("mailboxes_tenant_idx").on(table.tenantId),
  ],
);

export const mailboxCredentials = sqliteTable(
  "mailbox_credentials",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    refreshTokenEncrypted: text("refresh_token_encrypted"),
    tokenExpiresAt: integer("token_expires_at", { mode: "timestamp_ms" }).notNull(),
    encryptionKeyVersion: integer("encryption_key_version").notNull().default(1),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("mailbox_credentials_mailbox_unique").on(table.mailboxId),
    index("mailbox_credentials_tenant_idx").on(table.tenantId),
  ],
);

export const gmailOAuthAttempts = sqliteTable(
  "gmail_oauth_attempts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    stateHash: text("state_hash").notNull(),
    nonceHash: text("nonce_hash").notNull(),
    codeVerifierEncrypted: text("code_verifier_encrypted").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    returnPath: text("return_path").notNull().default("/"),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("gmail_oauth_attempts_state_hash_unique").on(table.stateHash),
    index("gmail_oauth_attempts_tenant_expiry_idx").on(table.tenantId, table.expiresAt),
  ],
);

export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", {
      enum: ["pending", "running", "succeeded", "failed", "cancelled"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    importedMessages: integer("imported_messages").notNull().default(0),
    importedThreads: integer("imported_threads").notNull().default(0),
    providerHistoryId: text("provider_history_id"),
    errorCode: text("error_code"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("sync_runs_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
    index("sync_runs_tenant_mailbox_idx").on(table.tenantId, table.mailboxId),
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
    providerMessageCount: integer("provider_message_count").notNull().default(0),
    completeThreadImported: integer("complete_thread_imported", { mode: "boolean" })
      .notNull()
      .default(false),
    lastSyncedAt: integer("last_synced_at", { mode: "timestamp_ms" }),
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
    snippet: text("snippet").notNull().default(""),
    labelsJson: text("labels_json").notNull().default("[]"),
    internetMessageId: text("internet_message_id"),
    inReplyTo: text("in_reply_to"),
    referencesJson: text("references_json").notNull().default("[]"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" }).notNull(),
    contentRetainUntil: integer("content_retain_until", { mode: "timestamp_ms" }),
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
    analysisKey: text("analysis_key").notNull(),
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
    detectedDatesJson: text("detected_dates_json").notNull().default("[]"),
    detectedDeadlinesJson: text("detected_deadlines_json").notNull().default("[]"),
    detectedFinancialAmountsJson: text("detected_financial_amounts_json")
      .notNull()
      .default("[]"),
    riskFlagsJson: text("risk_flags_json").notNull().default("[]"),
    confidenceScore: integer("confidence_score").notNull(),
    recommendedAssignee: text("recommended_assignee"),
    replyRequired: integer("reply_required", { mode: "boolean" }).notNull(),
    approvalRequired: integer("approval_required", { mode: "boolean" }).notNull(),
    suggestedReply: text("suggested_reply").notNull(),
    suggestedNextAction: text("suggested_next_action").notNull(),
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
    uniqueIndex("analyses_tenant_analysis_key_unique").on(
      table.tenantId,
      table.analysisKey,
    ),
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
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "cascade" }),
    proposalKey: text("proposal_key").notNull(),
    sourceAnalysisId: text("source_analysis_id").references(() => messageAnalyses.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: ["proposed", "edited", "approved", "rejected", "executed", "superseded"],
    })
      .notNull()
      .default("proposed"),
    currentVersion: integer("current_version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    ...timestamps,
  },
  (table) => [
    index("drafts_tenant_status_idx").on(table.tenantId, table.status),
    uniqueIndex("drafts_tenant_proposal_key_unique").on(table.tenantId, table.proposalKey),
  ],
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
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "restrict" }),
    draftVersionId: text("draft_version_id")
      .notNull()
      .references(() => draftVersions.id, { onDelete: "restrict" }),
    draftVersion: integer("draft_version").notNull(),
    draftContentHash: text("draft_content_hash").notNull(),
    actionType: text("action_type", { enum: ["create_gmail_draft"] })
      .notNull()
      .default("create_gmail_draft"),
    actionHash: text("action_hash").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "expired", "revoked"],
    })
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (table) => [
    index("approval_requests_tenant_status_idx").on(table.tenantId, table.status),
    uniqueIndex("approval_requests_tenant_action_hash_unique").on(table.tenantId, table.actionHash),
    uniqueIndex("approval_requests_tenant_draft_version_unique").on(
      table.tenantId,
      table.draftVersionId,
    ),
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
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "restrict" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "restrict" }),
    draftVersionId: text("draft_version_id")
      .notNull()
      .references(() => draftVersions.id, { onDelete: "restrict" }),
    approvalRequestId: text("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "restrict",
    }),
    actionType: text("action_type", { enum: ["create_gmail_draft"] })
      .notNull()
      .default("create_gmail_draft"),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status", {
      enum: ["proposed", "attempting", "succeeded", "failed", "ambiguous", "cancelled"],
    })
      .notNull()
      .default("proposed"),
    providerResultReference: text("provider_result_reference"),
    providerMessageId: text("provider_message_id"),
    providerThreadId: text("provider_thread_id"),
    rfcMessageId: text("rfc_message_id").notNull(),
    providerConfirmed: integer("provider_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    errorCode: text("error_code"),
    attemptedAt: integer("attempted_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
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
    sequence: integer("sequence").notNull(),
    messageId: text("message_id"),
    threadId: text("thread_id"),
    actorType: text("actor_type", { enum: ["system", "assistant", "user", "integration"] })
      .notNull(),
    actorId: text("actor_id"),
    eventType: text("event_type").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    result: text("result").notNull(),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    idempotencyKey: text("idempotency_key"),
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
    uniqueIndex("audit_events_tenant_sequence_unique").on(table.tenantId, table.sequence),
    index("audit_events_tenant_created_idx").on(table.tenantId, table.createdAt),
    index("audit_events_tenant_message_idx").on(table.tenantId, table.messageId),
    uniqueIndex("audit_events_tenant_idempotency_unique").on(
      table.tenantId,
      table.idempotencyKey,
    ),
  ],
);
