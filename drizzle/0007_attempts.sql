ALTER TABLE "issues" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "previous_failure" text;