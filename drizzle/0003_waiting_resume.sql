ALTER TABLE "events" ADD COLUMN "issue_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "factory_comment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "delivered_reply_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "answered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "answer" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "resume_context" text;--> statement-breakpoint
CREATE INDEX "events_issue_key_idx" ON "events" USING btree ("issue_key");--> statement-breakpoint
UPDATE "events" SET "issue_key" = "payload"->>'issueKey' WHERE "kind" = 'stage';