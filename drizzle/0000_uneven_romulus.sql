CREATE TABLE `action_executions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`approval_request_id` text,
	`action_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`provider_result_reference` text,
	`error_code` text,
	`attempted_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_request_id`) REFERENCES `approval_requests`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `action_executions_tenant_idempotency_unique` ON `action_executions` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `action_executions_tenant_status_idx` ON `action_executions` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`draft_version_id` text,
	`action_type` text NOT NULL,
	`action_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_version_id`) REFERENCES `draft_versions`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `approval_requests_tenant_status_idx` ON `approval_requests` (`tenant_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requests_tenant_action_hash_unique` ON `approval_requests` (`tenant_id`,`action_hash`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`provider_attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`risk_level` text DEFAULT 'review' NOT NULL,
	`extraction_status` text DEFAULT 'not_requested' NOT NULL,
	`object_reference` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_tenant_message_provider_unique` ON `attachments` (`tenant_id`,`message_id`,`provider_attachment_id`);--> statement-breakpoint
CREATE INDEX `attachments_tenant_message_idx` ON `attachments` (`tenant_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text,
	`thread_id` text,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`event_type` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`approval_status` text,
	`rule_references_json` text DEFAULT '[]' NOT NULL,
	`confidence_score` integer,
	`integration_result` text,
	`redacted_detail_json` text DEFAULT '{}' NOT NULL,
	`previous_event_hash` text,
	`event_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_tenant_event_hash_unique` ON `audit_events` (`tenant_id`,`event_hash`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_created_idx` ON `audit_events` (`tenant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_events_tenant_message_idx` ON `audit_events` (`tenant_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `draft_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`draft_id` text NOT NULL,
	`version` integer NOT NULL,
	`recipients_json` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`content_hash` text NOT NULL,
	`author_type` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`draft_id`) REFERENCES `drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_versions_tenant_draft_version_unique` ON `draft_versions` (`tenant_id`,`draft_id`,`version`);--> statement-breakpoint
CREATE TABLE `drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `drafts_tenant_status_idx` ON `drafts` (`tenant_id`,`status`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_mailbox_id` text NOT NULL,
	`address` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`credential_reference` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_tenant_provider_unique` ON `mailboxes` (`tenant_id`,`provider`,`provider_mailbox_id`);--> statement-breakpoint
CREATE INDEX `mailboxes_tenant_idx` ON `mailboxes` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_email` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_tenant_email_unique` ON `memberships` (`tenant_id`,`user_email`);--> statement-breakpoint
CREATE INDEX `memberships_email_idx` ON `memberships` (`user_email`);--> statement-breakpoint
CREATE TABLE `message_analyses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`version` integer NOT NULL,
	`primary_category` text NOT NULL,
	`secondary_categories_json` text DEFAULT '[]' NOT NULL,
	`priority` text NOT NULL,
	`sentiment` text NOT NULL,
	`sender_intent` text NOT NULL,
	`summary` text NOT NULL,
	`facts_json` text DEFAULT '[]' NOT NULL,
	`inferences_json` text DEFAULT '[]' NOT NULL,
	`missing_information_json` text DEFAULT '[]' NOT NULL,
	`entities_json` text DEFAULT '[]' NOT NULL,
	`required_actions_json` text DEFAULT '[]' NOT NULL,
	`risk_flags_json` text DEFAULT '[]' NOT NULL,
	`confidence_score` integer NOT NULL,
	`review_required` integer NOT NULL,
	`automation_eligibility_json` text NOT NULL,
	`audit_reason` text NOT NULL,
	`model_reference` text,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_tenant_message_version_unique` ON `message_analyses` (`tenant_id`,`message_id`,`version`);--> statement-breakpoint
CREATE INDEX `analyses_tenant_review_idx` ON `message_analyses` (`tenant_id`,`review_required`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`sender_name` text,
	`sender_email` text NOT NULL,
	`reply_to_email` text,
	`recipients_json` text NOT NULL,
	`copied_recipients_json` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`text_body` text NOT NULL,
	`received_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	`ingestion_status` text DEFAULT 'received' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_tenant_mailbox_provider_unique` ON `messages` (`tenant_id`,`mailbox_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `messages_tenant_thread_idx` ON `messages` (`tenant_id`,`thread_id`);--> statement-breakpoint
CREATE INDEX `messages_tenant_received_idx` ON `messages` (`tenant_id`,`received_at`);--> statement-breakpoint
CREATE TABLE `tenant_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`operating_mode` text DEFAULT 'safe' NOT NULL,
	`minimum_classification_confidence` integer DEFAULT 85 NOT NULL,
	`auto_draft` integer DEFAULT true NOT NULL,
	`auto_label` integer DEFAULT true NOT NULL,
	`auto_send` integer DEFAULT false NOT NULL,
	`auto_archive` integer DEFAULT false NOT NULL,
	`auto_forward` integer DEFAULT false NOT NULL,
	`auto_delete` integer DEFAULT false NOT NULL,
	`require_approval_before_send` integer DEFAULT true NOT NULL,
	`require_approval_for_new_contacts` integer DEFAULT true NOT NULL,
	`require_approval_for_financial` integer DEFAULT true NOT NULL,
	`require_approval_for_legal` integer DEFAULT true NOT NULL,
	`require_approval_for_complaints` integer DEFAULT true NOT NULL,
	`require_approval_for_refunds` integer DEFAULT true NOT NULL,
	`audit_log_enabled` integer DEFAULT true NOT NULL,
	`pii_redaction_enabled` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_settings_tenant_unique` ON `tenant_settings` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenants_slug_unique` ON `tenants` (`slug`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`provider_thread_id` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`last_message_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `threads_tenant_mailbox_provider_unique` ON `threads` (`tenant_id`,`mailbox_id`,`provider_thread_id`);--> statement-breakpoint
CREATE INDEX `threads_tenant_status_idx` ON `threads` (`tenant_id`,`status`);