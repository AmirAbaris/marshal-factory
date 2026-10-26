ALTER TABLE "jobs" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "codex_slot" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "execution" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_codex_slot_idx" ON "jobs" USING btree ("codex_slot") WHERE "jobs"."codex_slot" is not null;