import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { agents, runs } from "../db/schema";
import { costUsd } from "./pricing";

type Reader = Pick<NodePgDatabase<typeof schema>, "select">;

/** USD per issue key: every run of the issue, main session plus its subagents. */
export async function issueSpend(db: Reader, keys: readonly string[]) {
  const spend: Record<string, number> = {};
  if (keys.length === 0) return spend;
  const issueRuns = await db.select().from(runs).where(inArray(runs.issue_key, [...keys]));
  const sessions = issueRuns.map((r) => r.session_id);
  const issueAgents = sessions.length
    ? await db.select().from(agents).where(inArray(agents.session_id, sessions))
    : [];
  const keyOf = new Map(issueRuns.map((r) => [r.session_id, r.issue_key!]));
  for (const run of issueRuns) {
    spend[run.issue_key!] = (spend[run.issue_key!] ?? 0) + costUsd(run, run.model);
  }
  for (const agent of issueAgents) {
    const key = keyOf.get(agent.session_id)!;
    spend[key] = (spend[key] ?? 0) + costUsd(agent, agent.model);
  }
  return spend;
}
