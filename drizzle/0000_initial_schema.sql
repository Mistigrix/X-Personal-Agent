CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`post_version_id` integer NOT NULL,
	`content_hash` text NOT NULL,
	`decision` text NOT NULL,
	`telegram_user_id` integer NOT NULL,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_version_id`) REFERENCES `post_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_decision_check" CHECK(decision IN ('approved', 'rejected')),
	CONSTRAINT "approvals_content_hash_check" CHECK(length(content_hash) = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_post_version_id_uq` ON `approvals` (`post_version_id`);--> statement-breakpoint
CREATE INDEX `approvals_post_id_idx` ON `approvals` (`post_id`);--> statement-breakpoint
CREATE TABLE `ideas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`topic` text NOT NULL,
	`angle` text NOT NULL,
	`category` text NOT NULL,
	`language` text NOT NULL,
	`rationale` text,
	`profile_refs` text,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`job_run_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`job_run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ideas_status_check" CHECK(status IN ('new', 'drafted', 'discarded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ideas_public_id_unique` ON `ideas` (`public_id`);--> statement-breakpoint
CREATE INDEX `ideas_status_idx` ON `ideas` (`status`);--> statement-breakpoint
CREATE INDEX `ideas_fingerprint_idx` ON `ideas` (`fingerprint`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_name` text NOT NULL,
	`run_key` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	`meta` text,
	CONSTRAINT "job_runs_status_check" CHECK(status IN ('running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `job_runs_job_name_run_key_uq` ON `job_runs` (`job_name`,`run_key`);--> statement-breakpoint
CREATE INDEX `job_runs_job_name_started_at_idx` ON `job_runs` (`job_name`,`started_at`);--> statement-breakpoint
CREATE TABLE `post_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`version` integer NOT NULL,
	`text` text NOT NULL,
	`content_hash` text NOT NULL,
	`weighted_length` integer NOT NULL,
	`origin` text NOT NULL,
	`checks` text,
	`generation` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "post_versions_version_check" CHECK(version >= 1),
	CONSTRAINT "post_versions_content_hash_check" CHECK(length(content_hash) = 64),
	CONSTRAINT "post_versions_origin_check" CHECK(origin IN ('user_submitted', 'user_edited', 'ai_generated', 'ai_regenerated'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_versions_post_id_version_uq` ON `post_versions` (`post_id`,`version`);--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`public_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`language` text,
	`idea_id` integer,
	`scheduled_at` integer,
	`slot_key` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`x_post_id` text,
	`published_at` integer,
	`card_chat_id` integer,
	`card_message_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`idea_id`) REFERENCES `ideas`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "posts_source_check" CHECK(source IN ('personal', 'ai')),
	CONSTRAINT "posts_status_check" CHECK(status IN ('pending_confirmation', 'draft', 'scheduled', 'publishing', 'published', 'uncertain', 'failed', 'rejected', 'cancelled')),
	CONSTRAINT "posts_current_version_check" CHECK(current_version >= 1),
	CONSTRAINT "posts_retry_count_check" CHECK(retry_count >= 0),
	CONSTRAINT "posts_source_status_check" CHECK(NOT (source = 'personal' AND status IN ('draft', 'rejected')) AND NOT (source = 'ai' AND status = 'pending_confirmation')),
	CONSTRAINT "posts_scheduled_has_time_check" CHECK(status <> 'scheduled' OR scheduled_at IS NOT NULL),
	CONSTRAINT "posts_published_has_time_check" CHECK(status <> 'published' OR published_at IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_public_id_unique` ON `posts` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `posts_x_post_id_unique` ON `posts` (`x_post_id`);--> statement-breakpoint
CREATE INDEX `posts_status_scheduled_at_idx` ON `posts` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `posts_idea_id_idx` ON `posts` (`idea_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `posts_slot_key_holding_uq` ON `posts` (`slot_key`) WHERE status IN ('scheduled', 'publishing', 'uncertain', 'published');--> statement-breakpoint
CREATE TABLE `publication_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`post_version_id` integer NOT NULL,
	`content_hash` text NOT NULL,
	`status` text NOT NULL,
	`dry_run` integer NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`http_status` integer,
	`error_code` text,
	`error_message` text,
	`x_post_id` text,
	`retry_after` integer,
	`reconcile_checks` integer DEFAULT 0 NOT NULL,
	`last_reconciled_at` integer,
	`notified_at` integer,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`post_version_id`) REFERENCES `post_versions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "publication_attempts_status_check" CHECK(status IN ('in_flight', 'succeeded', 'failed_retryable', 'failed_permanent', 'unknown', 'reconciled_found', 'reconciled_not_found')),
	CONSTRAINT "publication_attempts_content_hash_check" CHECK(length(content_hash) = 64),
	CONSTRAINT "publication_attempts_reconcile_checks_check" CHECK(reconcile_checks >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `publication_attempts_open_per_post_uq` ON `publication_attempts` (`post_id`) WHERE status IN ('in_flight', 'unknown');--> statement-breakpoint
CREATE INDEX `publication_attempts_post_id_idx` ON `publication_attempts` (`post_id`);--> statement-breakpoint
CREATE INDEX `publication_attempts_status_idx` ON `publication_attempts` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
