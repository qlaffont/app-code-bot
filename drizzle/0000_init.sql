CREATE TABLE `threads` (
	`slack_thread_key` text PRIMARY KEY NOT NULL,
	`t3_thread_id` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
