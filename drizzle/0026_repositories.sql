ALTER TABLE "repo_settings" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "repo_settings" ADD COLUMN "execution" text;--> statement-breakpoint
CREATE UNIQUE INDEX "repo_settings_one_default_idx" ON "repo_settings" USING btree ("is_default") WHERE "repo_settings"."is_default";--> statement-breakpoint
ALTER TABLE "repo_settings" ADD CONSTRAINT "repo_settings_default_enabled_check" CHECK (not "repo_settings"."is_default" or "repo_settings"."enabled");