ALTER TABLE "issues" ADD COLUMN "nudged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "nudged_stage" "run_stage";