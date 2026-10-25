ALTER TABLE "jobs" ADD COLUMN "stop_event_id" text;--> statement-breakpoint
-- Jobs stopped before this column existed still owe their stop; the stop event id was the stage event id.
UPDATE "jobs" SET "stop_event_id" = "stage_event_id" WHERE "stage" = 'failed' AND "stage_event_id" LIKE 'stop:%';
