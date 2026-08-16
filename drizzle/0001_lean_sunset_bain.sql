CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_signed_in_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
INSERT OR IGNORE INTO `users` (`id`, `email`, `status`, `created_at`, `updated_at`)
SELECT 'legacy-user:' || lower(hex(`user_email`)), lower(`user_email`), 'active', min(`created_at`), max(`updated_at`)
FROM `memberships` GROUP BY lower(`user_email`);--> statement-breakpoint

CREATE TABLE `gmail_oauth_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`state_hash` text NOT NULL,
	`nonce_hash` text NOT NULL,
	`code_verifier_encrypted` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`return_path` text DEFAULT '/' NOT NULL,
	`scopes_json` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `gmail_oauth_attempts_state_hash_unique` ON `gmail_oauth_attempts` (`state_hash`);--> statement-breakpoint
CREATE INDEX `gmail_oauth_attempts_tenant_expiry_idx` ON `gmail_oauth_attempts` (`tenant_id`,`expires_at`);--> statement-breakpoint

CREATE TABLE `mailbox_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`access_token_encrypted` text NOT NULL,
	`refresh_token_encrypted` text,
	`token_expires_at` integer NOT NULL,
	`encryption_key_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `mailbox_credentials_mailbox_unique` ON `mailbox_credentials` (`mailbox_id`);--> statement-breakpoint
CREATE INDEX `mailbox_credentials_tenant_idx` ON `mailbox_credentials` (`tenant_id`);--> statement-breakpoint

CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`imported_messages` integer DEFAULT 0 NOT NULL,
	`imported_threads` integer DEFAULT 0 NOT NULL,
	`provider_history_id` text,
	`error_code` text,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX `sync_runs_tenant_idempotency_unique` ON `sync_runs` (`tenant_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `sync_runs_tenant_mailbox_idx` ON `sync_runs` (`tenant_id`,`mailbox_id`);--> statement-breakpoint

ALTER TABLE `action_executions` ADD `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `draft_id` text REFERENCES `drafts`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `draft_version_id` text REFERENCES `draft_versions`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `correlation_id` text;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `provider_message_id` text;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `provider_thread_id` text;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `rfc_message_id` text;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `provider_confirmed` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `action_executions` ADD `confirmed_at` integer;--> statement-breakpoint
UPDATE `action_executions`
SET `mailbox_id` = (SELECT m.`mailbox_id` FROM `messages` m WHERE m.`id` = `action_executions`.`message_id`),
	`draft_version_id` = (SELECT ar.`draft_version_id` FROM `approval_requests` ar WHERE ar.`id` = `action_executions`.`approval_request_id`),
	`draft_id` = (SELECT dv.`draft_id` FROM `approval_requests` ar JOIN `draft_versions` dv ON dv.`id` = ar.`draft_version_id` WHERE ar.`id` = `action_executions`.`approval_request_id`),
	`correlation_id` = `id`,
	`rfc_message_id` = '<legacy.' || replace(`id`, '-', '') || '@drafts.invalid>'
WHERE `correlation_id` IS NULL;--> statement-breakpoint

ALTER TABLE `approval_requests` ADD `thread_id` text REFERENCES `threads`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `draft_id` text REFERENCES `drafts`(`id`) ON DELETE restrict;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `draft_version` integer;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `draft_content_hash` text;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD `revoked_at` integer;--> statement-breakpoint
UPDATE `approval_requests`
SET `thread_id` = (SELECT m.`thread_id` FROM `messages` m WHERE m.`id` = `approval_requests`.`message_id`),
	`draft_id` = (SELECT dv.`draft_id` FROM `draft_versions` dv WHERE dv.`id` = `approval_requests`.`draft_version_id`),
	`draft_version` = (SELECT dv.`version` FROM `draft_versions` dv WHERE dv.`id` = `approval_requests`.`draft_version_id`),
	`draft_content_hash` = (SELECT dv.`content_hash` FROM `draft_versions` dv WHERE dv.`id` = `approval_requests`.`draft_version_id`),
	`expires_at` = COALESCE(`decided_at`, `updated_at`) + 1800000;--> statement-breakpoint
CREATE UNIQUE INDEX `approval_requests_tenant_draft_version_unique` ON `approval_requests` (`tenant_id`,`draft_version_id`);--> statement-breakpoint

ALTER TABLE `mailboxes` ADD `provider_account_id` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `granted_scopes_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `token_expires_at` integer;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `last_successful_sync_at` integer;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `last_history_id` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `connection_error_code` text;--> statement-breakpoint
ALTER TABLE `mailboxes` ADD `disconnected_at` integer;--> statement-breakpoint
UPDATE `mailboxes` SET `provider_account_id` = `provider_mailbox_id` WHERE `provider_account_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_provider_account_unique` ON `mailboxes` (`provider`,`provider_account_id`);--> statement-breakpoint

CREATE TABLE `__new_tenant_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`operating_mode` text DEFAULT 'safe' NOT NULL,
	`minimum_classification_confidence` integer DEFAULT 85 NOT NULL,
	`auto_draft` integer DEFAULT true NOT NULL,
	`auto_label` integer DEFAULT false NOT NULL,
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
	`initial_sync_limit` integer DEFAULT 25 NOT NULL,
	`content_retention_days` integer DEFAULT 30 NOT NULL,
	`attachments_enabled` integer DEFAULT false NOT NULL,
	`retain_draft_after_gmail_creation` integer DEFAULT true NOT NULL,
	`business_timezone` text DEFAULT 'UTC' NOT NULL,
	`business_instructions` text DEFAULT '' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_tenant_settings` (`id`, `tenant_id`, `operating_mode`, `minimum_classification_confidence`, `auto_draft`, `auto_label`, `auto_send`, `auto_archive`, `auto_forward`, `auto_delete`, `require_approval_before_send`, `require_approval_for_new_contacts`, `require_approval_for_financial`, `require_approval_for_legal`, `require_approval_for_complaints`, `require_approval_for_refunds`, `audit_log_enabled`, `pii_redaction_enabled`, `initial_sync_limit`, `content_retention_days`, `attachments_enabled`, `retain_draft_after_gmail_creation`, `business_timezone`, `business_instructions`, `version`, `created_at`, `updated_at`)
SELECT `id`, `tenant_id`, CASE WHEN `operating_mode` = 'draft' THEN 'draft' ELSE 'safe' END, `minimum_classification_confidence`, `auto_draft`, false, false, false, false, false, `require_approval_before_send`, `require_approval_for_new_contacts`, `require_approval_for_financial`, `require_approval_for_legal`, `require_approval_for_complaints`, `require_approval_for_refunds`, `audit_log_enabled`, `pii_redaction_enabled`, 25, 30, false, true, 'UTC', '', `version`, `created_at`, `updated_at` FROM `tenant_settings`;--> statement-breakpoint
DROP TABLE `tenant_settings`;--> statement-breakpoint
ALTER TABLE `__new_tenant_settings` RENAME TO `tenant_settings`;--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_settings_tenant_unique` ON `tenant_settings` (`tenant_id`);--> statement-breakpoint

ALTER TABLE `audit_events` ADD `target_type` text DEFAULT 'legacy_event' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `target_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `result` text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `correlation_id` text;--> statement-breakpoint
ALTER TABLE `audit_events` ADD `idempotency_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_tenant_idempotency_unique` ON `audit_events` (`tenant_id`,`idempotency_key`);--> statement-breakpoint

ALTER TABLE `drafts` ADD `thread_id` text REFERENCES `threads`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `drafts` ADD `mailbox_id` text REFERENCES `mailboxes`(`id`) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `drafts` ADD `proposal_key` text;--> statement-breakpoint
ALTER TABLE `drafts` ADD `source_analysis_id` text REFERENCES `message_analyses`(`id`) ON DELETE set null;--> statement-breakpoint
UPDATE `drafts`
SET `thread_id` = (SELECT m.`thread_id` FROM `messages` m WHERE m.`id` = `drafts`.`message_id`),
	`mailbox_id` = (SELECT m.`mailbox_id` FROM `messages` m WHERE m.`id` = `drafts`.`message_id`),
	`proposal_key` = 'legacy:' || `id`;--> statement-breakpoint
CREATE UNIQUE INDEX `drafts_tenant_proposal_key_unique` ON `drafts` (`tenant_id`,`proposal_key`);--> statement-breakpoint

ALTER TABLE `message_analyses` ADD `detected_dates_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `detected_deadlines_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `detected_financial_amounts_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `recommended_assignee` text;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `reply_required` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `approval_required` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `suggested_reply` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_analyses` ADD `suggested_next_action` text DEFAULT 'review' NOT NULL;--> statement-breakpoint

ALTER TABLE `messages` ADD `snippet` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `labels_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `internet_message_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `in_reply_to` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `references_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `content_retain_until` integer;--> statement-breakpoint
PRAGMA foreign_key_check;
