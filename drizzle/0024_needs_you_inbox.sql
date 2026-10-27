ALTER TYPE "public"."intent_kind" ADD VALUE 'approve_merge';--> statement-breakpoint
ALTER TYPE "public"."intent_kind" ADD VALUE 'request_changes';--> statement-breakpoint
ALTER TYPE "public"."intent_kind" ADD VALUE 'close_job';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "delivered_feedback_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;