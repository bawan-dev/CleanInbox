ALTER TABLE `message_analyses` ADD `analysis_key` text;--> statement-breakpoint
UPDATE `message_analyses` SET `analysis_key` = 'legacy:' || `id` WHERE `analysis_key` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `analyses_tenant_analysis_key_unique` ON `message_analyses` (`tenant_id`,`analysis_key`);--> statement-breakpoint
ALTER TABLE `threads` ADD `provider_message_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `complete_thread_imported` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `last_synced_at` integer;
