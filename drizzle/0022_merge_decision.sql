ALTER TYPE "public"."audit_action" ADD VALUE 'merge_decided';--> statement-breakpoint
CREATE TABLE "repo_settings" (
	"repo" text PRIMARY KEY NOT NULL,
	"autonomy" text DEFAULT 'off' NOT NULL,
	"protected_paths" jsonb,
	"max_changed_lines" integer,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "merge_assessment" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "merge_decision" jsonb;