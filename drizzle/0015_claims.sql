CREATE TABLE "intent_receipts" (
	"intent_id" text NOT NULL,
	"machine_id" text NOT NULL,
	"handled_at" timestamp with time zone NOT NULL,
	"result" text,
	CONSTRAINT "intent_receipts_intent_id_machine_id_pk" PRIMARY KEY("intent_id","machine_id")
);
--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "leased_by" text;--> statement-breakpoint
ALTER TABLE "intents" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "intent_receipts" ADD CONSTRAINT "intent_receipts_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Jobs claimed before FND-5 have a thread but no machine. While one machine exists it ran them all, so it owns them and keeps watching their PRs.
UPDATE "jobs" SET "machine_id" = (SELECT "id" FROM "machines") WHERE "machine_id" IS NULL AND ("t3_thread_id" IS NOT NULL OR "session_id" IS NOT NULL) AND (SELECT count(*) FROM "machines") = 1;
