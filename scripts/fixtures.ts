import type { jobs } from "../db/schema";
import { jobId } from "../lib/sources/shapes";

/** A claimed Linear job as the claim would insert it, for regressions that seed jobs rows. */
export function linearJob(
  externalId: string,
  key: string,
  overrides: Partial<typeof jobs.$inferInsert> & { state?: string | null; factoryCommentIds?: string[] } = {},
): typeof jobs.$inferInsert {
  const { state = null, factoryCommentIds = [], ...row } = overrides;
  const now = new Date();
  return {
    id: jobId("linear", externalId),
    source: "linear",
    external_id: externalId,
    key,
    title: "t",
    url: "u",
    repo: "ski043/factory-demo",
    writeback: { kind: "linear", issueId: externalId },
    source_state: { state, labels: [], factoryCommentIds },
    budget_usd: 5,
    claimed_at: now,
    updated_at: now,
    ...row,
  };
}
