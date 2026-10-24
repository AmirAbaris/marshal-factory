CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"heartbeat" jsonb NOT NULL,
	"inventory" jsonb,
	"inventory_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "machine_id" text;