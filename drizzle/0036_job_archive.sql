ALTER TYPE "public"."audit_action" ADD VALUE 'job_archived';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'job_unarchived';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "archived_by" text;