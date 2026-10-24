-- Renames issues to jobs and keeps every row. The whole change runs only while the issues table
-- still exists, in one statement, so applying this file again changes nothing.
DO $$
BEGIN
  IF to_regclass('public.issues') IS NULL THEN
    RETURN;
  END IF;

  CREATE TYPE "public"."job_source" AS ENUM('linear');

  ALTER TABLE "issues" RENAME TO "jobs";
  ALTER TABLE "jobs" RENAME COLUMN "linear_id" TO "external_id";
  ALTER TABLE "jobs" RENAME CONSTRAINT "issues_key_unique" TO "jobs_key_unique";
  ALTER INDEX "issues_claimed_at_idx" RENAME TO "jobs_claimed_at_idx";

  ALTER TABLE "jobs" ADD COLUMN "source" "job_source" DEFAULT 'linear' NOT NULL;
  ALTER TABLE "jobs" ADD COLUMN "id" text;
  UPDATE "jobs" SET "id" = "source"::text || ':' || "external_id";
  ALTER TABLE "jobs" DROP CONSTRAINT "issues_pkey";
  ALTER TABLE "jobs" ALTER COLUMN "id" SET NOT NULL;
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pkey" PRIMARY KEY ("id");
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_id_check" CHECK ("jobs"."id" = "jobs"."source"::text || ':' || "jobs"."external_id");

  -- Every job so far is a FAC issue worked in factory-demo, under the default 5 USD cap.
  ALTER TABLE "jobs" ADD COLUMN "repo" text NOT NULL DEFAULT 'ski043/factory-demo';
  ALTER TABLE "jobs" ALTER COLUMN "repo" DROP DEFAULT;
  ALTER TABLE "jobs" ADD COLUMN "budget_usd" double precision NOT NULL DEFAULT 5;
  ALTER TABLE "jobs" ALTER COLUMN "budget_usd" DROP DEFAULT;

  ALTER TABLE "jobs" ADD COLUMN "writeback" jsonb;
  ALTER TABLE "jobs" ADD COLUMN "source_state" jsonb;
  UPDATE "jobs" SET
    "writeback" = jsonb_build_object('kind', 'linear', 'issueId', "external_id"),
    "source_state" = jsonb_build_object(
      'state', "linear_state",
      'labels', "labels",
      'factoryCommentIds', "factory_comment_ids"
    );
  ALTER TABLE "jobs" ALTER COLUMN "writeback" SET NOT NULL;
  ALTER TABLE "jobs" ALTER COLUMN "source_state" SET NOT NULL;
  ALTER TABLE "jobs" DROP COLUMN "linear_state";
  ALTER TABLE "jobs" DROP COLUMN "labels";
  ALTER TABLE "jobs" DROP COLUMN "factory_comment_ids";

  -- Not-null constraints keep the old table's name through a rename; give them the new one.
  DECLARE
    c record;
  BEGIN
    FOR c IN
      SELECT con.conname, att.attname
      FROM pg_constraint con
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.conrelid = 'public.jobs'::regclass AND con.contype = 'n' AND con.conname LIKE 'issues\_%'
    LOOP
      EXECUTE format('ALTER TABLE "jobs" RENAME CONSTRAINT %I TO %I', c.conname, 'jobs_' || c.attname || '_not_null');
    END LOOP;
  END;

  ALTER TABLE "runs" RENAME COLUMN "issue_key" TO "job_key";
  ALTER TABLE "events" RENAME COLUMN "issue_key" TO "job_key";
  ALTER INDEX "events_issue_key_idx" RENAME TO "events_job_key_idx";
  -- Stored stage events carry the payload field under its new name too, so they still parse.
  UPDATE "events" SET "payload" = ("payload" - 'issueKey') || jsonb_build_object('jobKey', "payload"->'issueKey')
  WHERE "payload" ? 'issueKey';

  -- Every intent that named a Linear issue names its job id, claimed or not, so a stop for an
  -- issue the factory never claimed still resolves to nothing the same way.
  ALTER TABLE "intents" ADD COLUMN "job_id" text;
  UPDATE "intents" SET "job_id" = 'linear:' || "linear_id" WHERE "linear_id" IS NOT NULL;
  UPDATE "intents" i SET "job_id" = j."id" FROM "jobs" j WHERE i."job_id" IS NULL AND i."issue_key" = j."key";
  ALTER TABLE "intents" DROP COLUMN "issue_key";
  ALTER TABLE "intents" DROP COLUMN "linear_id";
END
$$;
