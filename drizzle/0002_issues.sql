CREATE TABLE "issues" (
	"linear_id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"linear_state" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stage" "run_stage" DEFAULT 'queued' NOT NULL,
	"stage_at" timestamp with time zone,
	"stage_summary" text,
	"question" text,
	"pr_url" text,
	"stage_event_id" text,
	"synced_event_id" text,
	"t3_thread_id" text,
	"session_id" text,
	"claimed_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "issues_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "issues_claimed_at_idx" ON "issues" USING btree ("claimed_at");