import type { jobs, runs } from "../db/schema";
import { attemptBranch } from "../lib/factory";
import { jobId } from "../lib/sources/shapes";

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
    claimed_at: now,
    updated_at: now,
    ...row,
  };
}

/** A run on the job's attempt branch with usage recorded, as ingest projects it, so its cost is known. */
export function usageRun(
  key: string,
  model = "claude-opus-5-5",
  tokens: { input?: number; output?: number; cacheRead?: number } = {},
  attempt = 1,
): typeof runs.$inferInsert {
  const now = new Date();
  return {
    session_id: `usage:${attemptBranch(key, attempt)}`,
    branch: attemptBranch(key, attempt),
    job_key: key,
    model,
    started_at: now,
    last_event_at: now,
    input_tokens: tokens.input ?? 10_000,
    output_tokens: tokens.output ?? 2_000,
    cache_read_tokens: tokens.cacheRead ?? 50_000,
  };
}
