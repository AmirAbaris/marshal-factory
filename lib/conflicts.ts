import { and, eq, isNotNull, isNull, ne, notInArray, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { jobs, runs } from "../db/schema";
import type { JobId } from "./sources/shapes";

/** Claims a conflicting PR head for one send-back; false when this head was already handled. */
export async function claimConflict(db: NodePgDatabase<typeof schema>, id: JobId, head: string) {
  const claimed = await db
    .update(jobs)
    .set({ conflict_head: head })
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.stage, "pr"),
        or(isNull(jobs.conflict_head), ne(jobs.conflict_head, head)),
      ),
    )
    .returning({ key: jobs.key });
  return claimed.length > 0;
}

/** Hand-started runs: a PR and a job key, but no claimed job that the PR check would see. */
export function unclaimedRunsWithPr(db: NodePgDatabase<typeof schema>) {
  return db
    .select()
    .from(runs)
    .where(
      and(
        isNotNull(runs.pr_url),
        isNotNull(runs.job_key),
        or(isNull(runs.stage), ne(runs.stage, "merged")),
        notInArray(runs.job_key, db.select({ key: jobs.key }).from(jobs)),
      ),
    );
}

export function conflictMessage(key: string, prUrl: string) {
  return [
    `Factory run ${key}: your pull request ${prUrl} now conflicts with main.`,
    "",
    "Bring the branch up to date and get the PR green again. Follow the merge-conflict section of the factory playbook (.agents/playbooks/factory.md):",
    "1. `git fetch origin` and `git merge origin/main` into this branch. Do not rebase and do not force-push.",
    "2. Resolve every conflict so that both main's change and yours keep working. Then run lint, typecheck, tests and build.",
    "3. Commit the merge, push, wait for CI and review bots, and call report_stage with stage pr and the PR URL again.",
    "If you cannot tell how the two changes should combine, report waiting with a concrete question instead of guessing.",
  ].join("\n");
}
