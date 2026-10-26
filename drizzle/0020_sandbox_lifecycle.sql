ALTER TYPE "public"."audit_action" ADD VALUE 'sandbox_login_failed';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "sandbox_snapshot" text;