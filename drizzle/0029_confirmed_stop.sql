ALTER TYPE "public"."intent_kind" ADD VALUE 'retry_stop';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stop" jsonb;