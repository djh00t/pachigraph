CREATE TABLE `history_records` (
	`rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`source_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`id` text NOT NULL,
	`source_timestamp` text NOT NULL,
	`source_text` text NOT NULL,
	`text_bytes` integer NOT NULL,
	`r2_key` text NOT NULL,
	`ingested_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `history_records_revision` ON `history_records` (`owner_id`,`thread_id`,`source_id`,`revision_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `history_records_owner_id_id` ON `history_records` (`owner_id`,`id`);--> statement-breakpoint
CREATE TABLE `thread_tombstones` (
	`owner_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`deleted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	PRIMARY KEY(`owner_id`, `thread_id`)
);
