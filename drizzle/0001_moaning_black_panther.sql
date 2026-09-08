ALTER TABLE `posts` ADD `messageId` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `suggestedReaction` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `reactedAt` integer;--> statement-breakpoint
ALTER TABLE `posts` ADD `reactionEmoji` text;--> statement-breakpoint
ALTER TABLE `posts` ADD `reactionError` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `threadV2Id` text;