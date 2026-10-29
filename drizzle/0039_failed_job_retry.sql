ALTER TYPE "public"."intent_kind" ADD VALUE 'retry_job' BEFORE 'slack_test';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "attempt_note" jsonb;