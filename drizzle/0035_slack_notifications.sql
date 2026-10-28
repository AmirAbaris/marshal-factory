ALTER TYPE "public"."intent_kind" ADD VALUE 'slack_test';--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"channel" text,
	"ts" text,
	"fingerprint" text,
	"resolution" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "slack_messages_state_check" CHECK ("slack_messages"."state" in ('posting', 'open', 'resolved'))
);
--> statement-breakpoint
CREATE INDEX "slack_messages_state_idx" ON "slack_messages" USING btree ("state");--> statement-breakpoint
CREATE INDEX "slack_messages_job_idx" ON "slack_messages" USING btree ("job_id");