import { z } from "zod";
import type { Usage } from "./events";
import type { JobHost } from "./host";

// Codex writes each thread to $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl.
// The first line is `session_meta` (thread id, root session id, cwd, git branch, and for a
// subagent the parent thread); each turn writes a `turn_context` with its model; every model call
// writes an `event_msg` `token_count` whose info.total_token_usage is the thread's running total.
// OpenAI counts cached input inside input_tokens and reasoning inside output_tokens, so input here
// is the uncached rest, like Claude's.

const tokenUsage = z.object({
  input_tokens: z.number().nonnegative().catch(0),
  cached_input_tokens: z.number().nonnegative().catch(0),
  cache_write_input_tokens: z.number().nonnegative().catch(0),
  output_tokens: z.number().nonnegative().catch(0),
});

const sessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({
    id: z.string().min(1),
    session_id: z.string().min(1).optional(),
    timestamp: z.string().optional(),
    cwd: z.string().optional(),
    git: z.object({ branch: z.string().nullish() }).nullish(),
    source: z.unknown().optional(),
  }),
});

const turnContext = z.object({ type: z.literal("turn_context"), payload: z.object({ model: z.string().min(1) }) });

const tokenCount = z.object({
  type: z.literal("event_msg"),
  timestamp: z.string().optional(),
  payload: z.object({ type: z.literal("token_count"), info: z.object({ total_token_usage: tokenUsage }).nullish() }),
});

const subagentSource = z.object({ subagent: z.object({ thread_spawn: z.object({ parent_thread_id: z.string() }) }) });

export type Rollout = {
  threadId: string;
  /** The root thread's id; a subagent shares its root's. */
  sessionId: string;
  parentThreadId: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: number | null;
  /** When the last token count was written; null with no count yet. */
  lastUsageAt: number | null;
  usage: Usage;
};

const time = (iso: string | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** One rollout file, or any subset of its lines that keeps the session_meta. Undefined without one. */
export function parseRollout(text: string): Rollout | undefined {
  let meta: z.infer<typeof sessionMeta>["payload"] | undefined;
  let model = "unknown";
  let total: z.infer<typeof tokenUsage> | undefined;
  let lastUsageAt: number | null = null;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let line: unknown;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const m = sessionMeta.safeParse(line);
    if (m.success) {
      meta ??= m.data.payload;
      continue;
    }
    const turn = turnContext.safeParse(line);
    if (turn.success) {
      model = turn.data.payload.model;
      continue;
    }
    const count = tokenCount.safeParse(line);
    const usage = count.success ? count.data.payload.info?.total_token_usage : undefined;
    // The total only grows; the largest one is the thread's spend so far, whatever the line order.
    if (usage && (!total || usage.input_tokens + usage.output_tokens >= total.input_tokens + total.output_tokens)) {
      total = usage;
      lastUsageAt = time(count.data!.timestamp) ?? lastUsageAt;
    }
  }
  if (!meta) return undefined;
  const cacheRead = total?.cached_input_tokens ?? 0;
  const cacheWrite = total?.cache_write_input_tokens ?? 0;
  const parent = subagentSource.safeParse(meta.source);
  return {
    threadId: meta.id,
    sessionId: meta.session_id ?? meta.id,
    parentThreadId: parent.success ? parent.data.subagent.thread_spawn.parent_thread_id : null,
    cwd: meta.cwd ?? null,
    branch: meta.git?.branch ?? null,
    startedAt: time(meta.timestamp),
    lastUsageAt,
    usage: {
      input: Math.max(0, (total?.input_tokens ?? 0) - cacheRead - cacheWrite),
      output: total?.output_tokens ?? 0,
      cacheRead,
      cacheWrite,
      model,
    },
  };
}

/** A thread may start before its first report opens the run. */
export const ROLLOUT_SLACK_MS = 60 * 60_000;

export type CodexRun = { cwd: string | null; branch: string | null; startedAt: number };

/**
 * The rollouts that are the run's: a root thread started at most ROLLOUT_SLACK_MS before the run
 * opened, in the run's worktree (or a directory inside it) or on its attempt branch, and every
 * thread of such a root's session, which is how its subagents are found. Each thread counts once.
 */
export function matchRollouts(rollouts: readonly Rollout[], run: CodexRun): Rollout[] {
  const inWorktree = (cwd: string | null) => Boolean(run.cwd && cwd && (cwd === run.cwd || cwd.startsWith(`${run.cwd.replace(/\/$/, "")}/`)));
  const roots = new Set(
    rollouts
      .filter((r) => r.threadId === r.sessionId && (r.startedAt ?? 0) >= run.startedAt - ROLLOUT_SLACK_MS)
      .filter((r) => inWorktree(r.cwd) || (run.branch !== null && r.branch === run.branch))
      .map((r) => r.threadId),
  );
  const byThread = new Map<string, Rollout>();
  for (const r of rollouts) {
    if (!roots.has(r.sessionId)) continue;
    const seen = byThread.get(r.threadId);
    if (!seen || r.usage.input + r.usage.output + r.usage.cacheRead > seen.usage.input + seen.usage.output + seen.usage.cacheRead) byThread.set(r.threadId, r);
  }
  return [...byThread.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.threadId.localeCompare(b.threadId));
}

export type CodexUsage = {
  /** The newest root thread: the run's own usage. */
  main: Rollout;
  /** Every other thread of the run, older roots and subagents, each priced on its own model. */
  others: Rollout[];
};

export function codexUsage(rollouts: readonly Rollout[], run: CodexRun): CodexUsage | undefined {
  const matched = matchRollouts(rollouts, run);
  const main = matched.filter((r) => r.threadId === r.sessionId).at(-1);
  return main && { main, others: matched.filter((r) => r !== main) };
}

const RECORD = "\u001e";

// Prints, per rollout written to in the last $2 minutes, a separator with its path, then only the
// lines the parser needs: the session_meta, the last turn_context and the last running total.
const READ_SCRIPT = `
cd "$1" 2>/dev/null || exit 0
find . -name 'rollout-*.jsonl' -mmin "-$2" | while IFS= read -r f; do
  printf '${RECORD}%s\\n' "$f"
  head -n 1 "$f"
  grep -F '"type":"turn_context"' "$f" | tail -n 1
  grep -F '"total_token_usage"' "$f" | tail -n 1
done
`;

/** Every rollout under codexHome written to since `sinceMs`, read on the host in one command. */
export async function readRollouts(host: JobHost, codexHome: string, sinceMs: number, now = Date.now()): Promise<Rollout[]> {
  const minutes = Math.max(1, Math.ceil((now - sinceMs) / 60_000));
  const { stdout } = await host.run("sh", ["-c", READ_SCRIPT, "sh", `${codexHome}/sessions`, String(minutes)], { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split(RECORD)
    .slice(1)
    .flatMap((chunk) => {
      const rollout = parseRollout(chunk.slice(chunk.indexOf("\n") + 1));
      return rollout ? [rollout] : [];
    });
}
