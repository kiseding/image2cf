CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	`reset_at` integer NOT NULL
);
CREATE INDEX `rate_limits_reset_at_idx` ON `rate_limits` (`reset_at`);
