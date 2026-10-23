ALTER TABLE "runs" ADD COLUMN "stage_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stage_summary" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "question" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "pr_url" text;