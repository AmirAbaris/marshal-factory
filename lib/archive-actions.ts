import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { auditLog, jobs } from "@/db/schema";
import { archiveRefusal, FINISHED_STAGES, isArchived } from "@/lib/archive";
import { isOwner } from "@/lib/auth/owner";
import type { InboxDeps } from "@/lib/inbox-actions";
import type { JobId } from "@/lib/sources/shapes";

// The panel's owner-only Archive and Unarchive. Each sets or clears jobs.archived_at and audits the
// change per job; nothing else changes, so the runner, the source and GitHub never see it. Both are
// idempotent: a job already in the asked state is left alone and not audited again.

export type ArchiveDeps = Pick<InboxDeps, "db" | "user" | "now">;
export type ArchiveOutcome = { ok: true; message: string } | { ok: false; message: string };

const OWNER_ONLY = "Only the factory owner can archive jobs.";
/** The jobs feed's limit; the panel never shows more to pick from. */
const MAX_JOBS = 200;
const idsSchema = z.array(z.string().min(1)).min(1, "Pick at least one job.").max(MAX_JOBS, `Pick at most ${MAX_JOBS} jobs.`);

const plural = (n: number) => `${n} ${n === 1 ? "job" : "jobs"}`;

async function ownerJobs(deps: ArchiveDeps, raw: unknown) {
  const user = await deps.user();
  if (!isOwner(user)) return { ok: false, message: OWNER_ONLY } as const;
  const parsed = idsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]!.message } as const;
  const ids = [...new Set(parsed.data)] as JobId[];
  const rows = await deps.db.select().from(jobs).where(inArray(jobs.id, ids));
  const missing = ids.find((id) => !rows.some((r) => r.id === id));
  if (missing) return { ok: false, message: `No job ${missing}.` } as const;
  return { ok: true, actor: user!.email, rows } as const;
}

/** Archives finished jobs; refuses the whole request when any of them is still working. */
export async function archiveJobs(deps: ArchiveDeps, ids: unknown): Promise<ArchiveOutcome> {
  const found = await ownerJobs(deps, ids);
  if (!found.ok) return found;
  for (const job of found.rows) {
    const refused = archiveRefusal(job);
    if (refused) return { ok: false, message: `${job.key}: ${refused}` };
  }
  const now = (deps.now ?? (() => new Date()))();
  const due = found.rows.filter((job) => !isArchived(job));
  await deps.db.transaction(async (tx) => {
    for (const job of due) {
      // The stage check again in the update, so a job reclaimed since the read stays on the board.
      const [updated] = await tx
        .update(jobs)
        .set({ archived_at: now, archived_by: found.actor })
        .where(and(eq(jobs.id, job.id), inArray(jobs.stage, [...FINISHED_STAGES])))
        .returning({ id: jobs.id });
      if (!updated) continue;
      await tx.insert(auditLog).values({
        id: `archive:${job.id}:${now.toISOString()}`,
        at: now,
        actor: found.actor,
        action: "job_archived",
        job_id: job.id,
        target: job.pr_url ?? job.url,
        head_sha: "",
        result: "ok",
      });
    }
  });
  return { ok: true, message: `Archived ${plural(found.rows.length)}.` };
}

/** Puts archived jobs back on the panel. */
export async function unarchiveJobs(deps: ArchiveDeps, ids: unknown): Promise<ArchiveOutcome> {
  const found = await ownerJobs(deps, ids);
  if (!found.ok) return found;
  const now = (deps.now ?? (() => new Date()))();
  const due = found.rows.filter((job) => job.archived_at !== null);
  await deps.db.transaction(async (tx) => {
    for (const job of due) {
      await tx.update(jobs).set({ archived_at: null, archived_by: null }).where(eq(jobs.id, job.id));
      await tx.insert(auditLog).values({
        id: `unarchive:${job.id}:${now.toISOString()}`,
        at: now,
        actor: found.actor,
        action: "job_unarchived",
        job_id: job.id,
        target: job.pr_url ?? job.url,
        head_sha: "",
        result: "ok",
      });
    }
  });
  return { ok: true, message: `Restored ${plural(found.rows.length)}.` };
}
