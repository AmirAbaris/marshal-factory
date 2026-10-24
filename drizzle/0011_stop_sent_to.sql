ALTER TABLE "issues" ADD COLUMN "stop_sent_to" text;--> statement-breakpoint
-- Stops recorded before this column already messaged their thread directly.
UPDATE "issues" SET "stop_sent_to" = "t3_thread_id" WHERE "stage_event_id" LIKE 'stop:%';