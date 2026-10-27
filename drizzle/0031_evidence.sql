CREATE TABLE "job_evidence" (
	"job_key" text NOT NULL,
	"sha" text NOT NULL,
	"attempt" integer NOT NULL,
	"repo" text NOT NULL,
	"clean" boolean NOT NULL,
	"producer" text NOT NULL,
	"source" text NOT NULL,
	"checks" jsonb NOT NULL,
	"event_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_evidence_job_key_sha_pk" PRIMARY KEY("job_key","sha")
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
CREATE INDEX "job_evidence_job_recorded_idx" ON "job_evidence" USING btree ("job_key","recorded_at");