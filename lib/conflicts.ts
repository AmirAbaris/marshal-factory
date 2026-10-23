import { and, eq, isNull, ne, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { issues } from "../db/schema";

/** Claims a conflicting PR head for one send-back; false when this head was already handled. */
export async function claimConflict(db: NodePgDatabase<typeof schema>, linearId: string, head: string) {
  const claimed = await db
    .update(issues)
    .set({ conflict_head: head })
    .where(
      and(
        eq(issues.linear_id, linearId),
        eq(issues.stage, "pr"),
        or(isNull(issues.conflict_head), ne(issues.conflict_head, head)),
      ),
    )
    .returning({ key: issues.key });
  return claimed.length > 0;
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
