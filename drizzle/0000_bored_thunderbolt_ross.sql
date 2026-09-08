CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shortcode` text NOT NULL,
	`permalink` text NOT NULL,
	`mediaType` text DEFAULT 'unknown' NOT NULL,
	`mediaId` text,
	`caption` text,
	`authorUsername` text,
	`messageText` text,
	`thumbnailUrl` text,
	`thumbnailFile` text,
	`threadId` text,
	`itemId` text,
	`senderId` text,
	`senderUsername` text,
	`sharedAt` integer,
	`viewed` integer DEFAULT false NOT NULL,
	`viewedAt` integer,
	`createdAt` integer NOT NULL,
	`analysisStatus` text DEFAULT 'pending' NOT NULL,
	`category` text,
	`summary` text,
	`items` text,
	`analysisModel` text,
	`analysisCostUsd` real,
	`analysisError` text,
	`analyzedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_shortcode_unique` ON `posts` (`shortcode`);--> statement-breakpoint
CREATE INDEX `posts_sharedAt_idx` ON `posts` (`sharedAt`);--> statement-breakpoint
CREATE INDEX `posts_analysisStatus_idx` ON `posts` (`analysisStatus`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `syncRuns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`startedAt` integer NOT NULL,
	`finishedAt` integer,
	`status` text DEFAULT 'running' NOT NULL,
	`threadsScanned` integer DEFAULT 0 NOT NULL,
	`itemsScanned` integer DEFAULT 0 NOT NULL,
	`postsAdded` integer DEFAULT 0 NOT NULL,
	`postsAnalyzed` integer DEFAULT 0 NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `threads` (
	`threadId` text PRIMARY KEY NOT NULL,
	`title` text,
	`participants` text,
	`watch` integer DEFAULT false NOT NULL,
	`lastItemAt` integer,
	`lastSyncedAt` integer,
	`postsFound` integer DEFAULT 0 NOT NULL
);
