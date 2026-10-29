CREATE TABLE "job_screenshots" (
	"stage_event_id" text NOT NULL,
	"file" text NOT NULL,
	"job_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"event_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_screenshots_stage_event_id_file_pk" PRIMARY KEY("stage_event_id","file")
);
--> statement-breakpoint
CREATE INDEX "job_screenshots_job_idx" ON "job_screenshots" USING btree ("job_key");