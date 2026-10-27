CREATE TYPE "public"."onboarding_state" AS ENUM('analyzing', 'needs_input', 'building', 'ready', 'rebuilding', 'failed');--> statement-breakpoint
ALTER TYPE "public"."intent_kind" ADD VALUE 'onboard_repo';--> statement-breakpoint
ALTER TYPE "public"."intent_kind" ADD VALUE 'rebuild_repo_image';--> statement-breakpoint
ALTER TYPE "public"."intent_kind" ADD VALUE 'repo_push';--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "onboarding_state" "onboarding_state";--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "onboarding_detail" jsonb;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "onboarding_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "onboarding_at" timestamp with time zone;