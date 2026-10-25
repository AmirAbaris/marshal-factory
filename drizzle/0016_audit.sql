CREATE TYPE "public"."audit_action" AS ENUM('merge_requested', 'merge_succeeded', 'merge_failed');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('ok', 'head_moved', 'not_mergeable', 'refused', 'error');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"actor" text NOT NULL,
	"action" "audit_action" NOT NULL,
	"job_id" text NOT NULL,
	"target" text NOT NULL,
	"head_sha" text NOT NULL,
	"result" "audit_result",
	"detail" text
);
--> statement-breakpoint
CREATE INDEX "audit_log_job_at_idx" ON "audit_log" USING btree ("job_id","at");