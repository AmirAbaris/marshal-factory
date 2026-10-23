CREATE TYPE "public"."intent_kind" AS ENUM('claim', 'stop', 'answer', 'merged', 'recheck_conflicts');--> statement-breakpoint
CREATE TABLE "intents" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "intent_kind" NOT NULL,
	"issue_key" text,
	"linear_id" text,
	"pr_url" text,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL,
	"handled_at" timestamp with time zone,
	"result" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "intents_open_idx" ON "intents" USING btree ("handled_at","created_at");