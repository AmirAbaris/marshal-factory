import { inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { agents, runs } from "../db/schema";
import { hasTokens, knownCostUsd, type PricingOverrides } from "./pricing";

type Reader = Pick<NodePgDatabase<typeof schema>, "select">;

/**
 * What one attempt spent. `known` is false when no usage was recorded for it, or some of its
 * tokens are on a model without a price; `usd` then counts only what could be priced.
 */
export type BranchCost = { usd: number; known: boolean };

/**
 * Cost per factory branch: every run on it, main session plus subagents. Each attempt at a job
 * gets its own branch, so this is the spend of one attempt.
 */
export async function branchCosts(db: Reader, branches: readonly string[], overrides?: PricingOverrides) {
  const costs: Record<string, BranchCost> = {};
  if (branches.length === 0) return costs;
  const branchRuns = await db.select().from(runs).where(inArray(runs.branch, [...branches]));
  const sessions = branchRuns.map((r) => r.session_id);
  const branchAgents = sessions.length
    ? await db.select().from(agents).where(inArray(agents.session_id, sessions))
    : [];
  const branchOf = new Map(branchRuns.map((r) => [r.session_id, r.branch!]));
  const recorded = new Set<string>();
  const add = (branch: string, row: Parameters<typeof knownCostUsd>[0] & { model: string | null }) => {
    const cost = (costs[branch] ??= { usd: 0, known: true });
    if (hasTokens(row)) recorded.add(branch);
    const usd = knownCostUsd(row, row.model, overrides);
    if (usd === undefined) cost.known = false;
    else cost.usd += usd;
  };
  for (const run of branchRuns) add(run.branch!, run);
  for (const agent of branchAgents) add(branchOf.get(agent.session_id)!, agent);
  for (const [branch, cost] of Object.entries(costs)) if (!recorded.has(branch)) cost.known = false;
  return costs;
}

/** USD per factory branch, counting unpriced tokens as 0. */
export async function branchSpend(db: Reader, branches: readonly string[], overrides?: PricingOverrides) {
  const costs = await branchCosts(db, branches, overrides);
  return Object.fromEntries(Object.entries(costs).map(([branch, { usd }]) => [branch, usd]));
}
