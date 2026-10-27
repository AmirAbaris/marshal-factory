CREATE TABLE "codex_slot_leases" (
	"slot" text PRIMARY KEY NOT NULL,
	"holder_kind" text NOT NULL,
	"holder_id" text NOT NULL,
	"leased_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "codex_slot_leases_holder_kind_check" CHECK ("codex_slot_leases"."holder_kind" in ('job', 'onboarding'))
);
--> statement-breakpoint
INSERT INTO "codex_slot_leases" ("slot", "holder_kind", "holder_id")
	SELECT "codex_slot", 'job', "id" FROM "jobs" WHERE "codex_slot" IS NOT NULL
	ON CONFLICT ("slot") DO NOTHING;
--> statement-breakpoint
INSERT INTO "codex_slot_leases" ("slot", "holder_kind", "holder_id")
	SELECT "onboarding_detail"->'run'->>'slot', 'onboarding', "repo" FROM "repo_settings" WHERE "onboarding_detail"->'run'->>'slot' IS NOT NULL
	ON CONFLICT ("slot") DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION "codex_slot_lease_move"(kind text, holder text, old_slot text, new_slot text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF old_slot IS NOT DISTINCT FROM new_slot THEN
		RETURN;
	END IF;
	IF old_slot IS NOT NULL THEN
		DELETE FROM "codex_slot_leases" WHERE "slot" = old_slot AND "holder_kind" = kind AND "holder_id" = holder;
	END IF;
	IF new_slot IS NOT NULL THEN
		INSERT INTO "codex_slot_leases" ("slot", "holder_kind", "holder_id") VALUES (new_slot, kind, holder) ON CONFLICT ("slot") DO NOTHING;
		IF NOT EXISTS (SELECT 1 FROM "codex_slot_leases" WHERE "slot" = new_slot AND "holder_kind" = kind AND "holder_id" = holder) THEN
			RAISE EXCEPTION 'Codex slot % is leased to another holder', new_slot USING ERRCODE = 'unique_violation';
		END IF;
	END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION "jobs_codex_slot_lease"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "codex_slot_lease_move"('job', OLD."id", OLD."codex_slot", NULL);
		RETURN OLD;
	END IF;
	PERFORM "codex_slot_lease_move"('job', NEW."id", CASE WHEN TG_OP = 'UPDATE' THEN OLD."codex_slot" END, NEW."codex_slot");
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "jobs_codex_slot_lease" AFTER INSERT OR UPDATE OF "codex_slot" OR DELETE ON "jobs"
	FOR EACH ROW EXECUTE FUNCTION "jobs_codex_slot_lease"();
--> statement-breakpoint
CREATE FUNCTION "repo_settings_codex_slot_lease"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		PERFORM "codex_slot_lease_move"('onboarding', OLD."repo", OLD."onboarding_detail"->'run'->>'slot', NULL);
		RETURN OLD;
	END IF;
	PERFORM "codex_slot_lease_move"(
		'onboarding',
		NEW."repo",
		CASE WHEN TG_OP = 'UPDATE' THEN OLD."onboarding_detail"->'run'->>'slot' END,
		NEW."onboarding_detail"->'run'->>'slot'
	);
	RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "repo_settings_codex_slot_lease" AFTER INSERT OR UPDATE OF "onboarding_detail" OR DELETE ON "repo_settings"
	FOR EACH ROW EXECUTE FUNCTION "repo_settings_codex_slot_lease"();
