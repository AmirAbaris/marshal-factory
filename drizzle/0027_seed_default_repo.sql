-- Every repo a job ran in joins the registry, and the one with the newest job becomes the default.
-- The runner registers its configured checkouts at startup too, making the first one the default when none is.
INSERT INTO "repo_settings" ("repo", "updated_at", "updated_by")
SELECT DISTINCT "repo", now(), 'migration' FROM "jobs"
ON CONFLICT ("repo") DO NOTHING;--> statement-breakpoint
UPDATE "repo_settings" SET "is_default" = true
WHERE "repo" = (SELECT "repo" FROM "jobs" ORDER BY "claimed_at" DESC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "repo_settings" WHERE "is_default");
