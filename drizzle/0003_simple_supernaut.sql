DROP INDEX `memberships_email_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_email_unique` ON `memberships` (`user_email`);