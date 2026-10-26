ALTER TYPE "public"."audit_action" ADD VALUE 'override_fallback';--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "execution" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "ticket_overrides" jsonb;