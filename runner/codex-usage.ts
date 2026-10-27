import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { db } from "../db/client";
import { agents, runs, type RunRow } from "../db/schema";
import { codexUsage, readRollouts, ROLLOUT_SLACK_MS } from "../lib/codex-usage";
import type { Usage } from "../lib/events";
import { HostAsleepError, HostGoneError, localHost, type JobHost } from "../lib/host";
import { CODEX_HOME } from "../lib/sandbox";
import { postEvent } from "./ingest-client";

// Codex has no hooks, so its usage is read from its rollout files on the job's host (see
// lib/codex-usage.ts) and posted as the same `usage` event a Claude Code reporter sends: the run's
// newest root thread is the run's usage, every other thread of it a subagent row. Ingest keeps the
// greatest totals, so a replay or an older read never lowers them.

/** Where Codex writes its sessions on the host: the sandbox's CODEX_HOME, or this machine's. */
export const codexHomeOf = (host: JobHost) => (host === localHost ? (process.env.CODEX_HOME ?? join(homedir(), ".codex")) : CODEX_HOME);

type Tokens = Pick<RunRow, "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">;
const lags = (u: Usage, row: Tokens | undefined) =>
  !row || u.input > row.input_tokens || u.output > row.output_tokens || u.cacheRead > row.cache_read_tokens || u.cacheWrite > row.cache_write_tokens;

/** Posts the run's Codex usage when its rollouts are ahead of the board; true when it did. */
export async function recordCodexUsage(run: RunRow, host: JobHost) {
  const startedAt = run.started_at.getTime();
  const rollouts = await readRollouts(host, codexHomeOf(host), startedAt - ROLLOUT_SLACK_MS);
  const usage = codexUsage(rollouts, { cwd: run.cwd, branch: run.branch, startedAt });
  if (!usage) return false;
  const others = usage.others.map((r) => ({ agentId: `codex:${r.threadId}`, usage: r.usage }));
  const rows = await db.select().from(agents).where(eq(agents.session_id, run.session_id));
  const behind = lags(usage.main.usage, run) || others.some((o) => lags(o.usage, rows.find((r) => r.agent_id === o.agentId)));
  if (!behind) return false;
  const fingerprint = [usage.main.usage, ...others.map((o) => o.usage)].map((u) => `${u.input}.${u.output}.${u.cacheRead}.${u.cacheWrite}`).join(":");
  await postEvent({
    eventId: `codex-usage:${run.session_id}:${fingerprint}`,
    sessionId: run.session_id,
    // The thread's own last count, so the usage never reads as new activity.
    at: Math.min(usage.main.lastUsageAt ?? run.last_event_at.getTime(), run.last_event_at.getTime()),
    kind: "usage",
    usage: usage.main.usage,
    agents: others,
  });
  return true;
}

/**
 * Records the job's Codex usage before its sandbox ends or sleeps, since its rollouts go with it.
 * A failure is logged and never holds up the teardown or the hibernate.
 */
export async function recordJobCodexUsage(key: string, host: JobHost) {
  try {
    const codexRuns = await db.select().from(runs).where(and(eq(runs.job_key, key), like(runs.session_id, "mcp:%")));
    for (const run of codexRuns) await recordCodexUsage(run, host);
  } catch (error) {
    const reason = error instanceof HostGoneError || error instanceof HostAsleepError ? error.message : String(error);
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "codex-usage:skipped", key, reason }));
  }
}
