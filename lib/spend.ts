import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { agents, runs } from "../db/schema";
import { costUsd } from "./pricing";

type Reader = Pick<NodePgDatabase<typeof schema>, "select">;

/**
 * USD per factory branch: every run on it, main session plus subagents. Each attempt at a job
 * gets its own branch, so this is the spend of one attempt, which is what the cap limits.
 */
export async function branchSpend(db: Reader, branches: readonly string[]) {
  const spend: Record<string, number> = {};
  if (branches.length === 0) return spend;
  const branchRuns = await db.select().from(runs).where(inArray(runs.branch, [...branches]));
  const sessions = branchRuns.map((r) => r.session_id);
  const branchAgents = sessions.length
    ? await db.select().from(agents).where(inArray(agents.session_id, sessions))
    : [];
  const branchOf = new Map(branchRuns.map((r) => [r.session_id, r.branch!]));
  for (const run of branchRuns) {
    spend[run.branch!] = (spend[run.branch!] ?? 0) + costUsd(run, run.model);
  }
  for (const agent of branchAgents) {
    const branch = branchOf.get(agent.session_id)!;
    spend[branch] = (spend[branch] ?? 0) + costUsd(agent, agent.model);
  }
  return spend;
}
