ALTER TABLE "jobs" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "source" SET DEFAULT 'linear';--> statement-breakpoint
DROP TYPE "public"."job_source";