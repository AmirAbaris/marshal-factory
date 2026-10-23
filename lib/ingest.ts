import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { agents, events, issues, runs } from "../db/schema";
import type { FactoryEvent, Usage } from "./events";
import { issueKeyFromBranch } from "./factory";
import { branchSpend } from "./spend";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type AgentRow = typeof agents.$inferSelect;
type RunStatus = (typeof runs.$inferSelect)["status"];

// A background agent can finish after its turn ended, so agent_stop leaves the status alone.
const RUN_STATUS: Record<FactoryEvent["kind"], RunStatus | null> = {
  session_start: "active",
  agent_start: "active",
  agent_launched: "active",
  agent_stop: null,
  turn_stop: "idle",
  usage: null,
  stage: null,
  session_end: "ended",
};


const when = (ms: number) => new Date(ms);

function usageColumns(usage: Usage) {
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    cache_read_tokens: usage.cacheRead,
    cache_write_tokens: usage.cacheWrite,
  };
}

const keepGreater = (column: { name: string }) =>
  sql.raw(`greatest(runs."${column.name}", excluded."${column.name}")`);

// Session totals only grow, so greatest() makes replays and reordering harmless.
async function upsertRun(tx: Tx, event: FactoryEvent) {
  const at = when(event.at);
  const kindMeta =
    event.kind === "session_start"
      ? {
          cwd: event.cwd,
          repo: event.repo,
          branch: event.branch,
          issue_key: issueKeyFromBranch(event.branch),
          t3_thread_id: event.t3ThreadId,
          title: event.title,
          model: event.model,
        }
      : event.kind === "turn_stop" || event.kind === "usage"
        ? { model: event.usage.model, ...usageColumns(event.usage) }
        : {};
  const meta = {
    ...kindMeta,
    ...(event.transcriptPath ? { transcript_path: event.transcriptPath } : {}),
  };
  const keep = (name: string) =>
    sql.raw(`coalesce(excluded."${name}", runs."${name}")`);

  await tx
    .insert(runs)
    .values({
      session_id: event.sessionId,
      status: RUN_STATUS[event.kind] ?? "active",
      started_at: at,
      last_event_at: at,
      ...meta,
    })
    .onConflictDoUpdate({
      target: runs.session_id,
      set: {
        started_at: sql.raw(`least(runs."started_at", excluded."started_at")`),
        last_event_at: sql.raw(
          `greatest(runs."last_event_at", excluded."last_event_at")`,
        ),
        // A late event must not drag the status back past a newer one.
        ...(RUN_STATUS[event.kind]
          ? {
              status: sql.raw(
                `case when excluded."last_event_at" >= runs."last_event_at" then excluded."status" else runs."status" end`,
              ),
            }
          : {}),
        ...Object.fromEntries(
          ["cwd", "repo", "branch", "issue_key", "t3_thread_id", "title", "model", "transcript_path"]
            .filter((name) => name in meta)
            .map((name) => [name, keep(name)]),
        ),
        ...("input_tokens" in meta
          ? {
              input_tokens: keepGreater(runs.input_tokens),
              output_tokens: keepGreater(runs.output_tokens),
              cache_read_tokens: keepGreater(runs.cache_read_tokens),
              cache_write_tokens: keepGreater(runs.cache_write_tokens),
            }
          : {}),
      },
    });
}

const byToolUseId = async (tx: Tx, id: string) =>
  (await tx.select().from(agents).where(eq(agents.tool_use_id, id)))[0];
const byAgentId = async (tx: Tx, id: string) =>
  (await tx.select().from(agents).where(eq(agents.agent_id, id)))[0];

const settle = (a: AgentRow["status"], b: AgentRow["status"]) =>
  a === "running" ? b : a;

/** Rows created from an agent_stop that beat its agent_launched carry this prefix. */
const pendingKey = (agentId: string) => `agent:${agentId}`;

async function applyAgentStart(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_start" }>,
) {
  await tx
    .insert(agents)
    .values({
      tool_use_id: e.toolUseId,
      session_id: e.sessionId,
      parent_agent_id: e.parentAgentId,
      subagent_type: e.subagentType,
      description: e.description,
      model: e.model,
      status: "running",
      started_at: when(e.at),
    })
    .onConflictDoUpdate({
      target: agents.tool_use_id,
      // Status is untouched: a stop that already landed stays final.
      set: {
        started_at: sql.raw(`least(agents."started_at", excluded."started_at")`),
        parent_agent_id: sql.raw(
          `coalesce(excluded."parent_agent_id", agents."parent_agent_id")`,
        ),
        subagent_type: sql.raw(
          `coalesce(excluded."subagent_type", agents."subagent_type")`,
        ),
        description: sql.raw(
          `coalesce(excluded."description", agents."description")`,
        ),
        // An existing row came from a stop or launch, whose model is the resolved id, not the alias.
        model: sql.raw(`coalesce(agents."model", excluded."model")`),
      },
    });
}

async function applyAgentLaunched(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_launched" }>,
) {
  const real = await byToolUseId(tx, e.toolUseId);
  const linked = await byAgentId(tx, e.agentId);

  if (linked && linked.tool_use_id === e.toolUseId) return;

  if (linked && real) {
    await tx.delete(agents).where(eq(agents.tool_use_id, linked.tool_use_id));
    await tx
      .update(agents)
      .set({
        agent_id: e.agentId,
        status: settle(real.status, linked.status),
        ended_at: real.ended_at ?? linked.ended_at,
        // The stop's model is a resolved id; the start's is the requested alias.
        model: linked.model ?? real.model,
        started_at:
          real.started_at < linked.started_at ? real.started_at : linked.started_at,
        input_tokens: Math.max(real.input_tokens, linked.input_tokens),
        output_tokens: Math.max(real.output_tokens, linked.output_tokens),
        cache_read_tokens: Math.max(real.cache_read_tokens, linked.cache_read_tokens),
        cache_write_tokens: Math.max(
          real.cache_write_tokens,
          linked.cache_write_tokens,
        ),
      })
      .where(eq(agents.tool_use_id, e.toolUseId));
  } else if (linked) {
    await tx
      .update(agents)
      .set({ tool_use_id: e.toolUseId })
      .where(eq(agents.tool_use_id, linked.tool_use_id));
  } else if (real) {
    await tx
      .update(agents)
      .set({ agent_id: e.agentId })
      .where(eq(agents.tool_use_id, e.toolUseId));
  } else {
    await tx.insert(agents).values({
      tool_use_id: e.toolUseId,
      session_id: e.sessionId,
      agent_id: e.agentId,
      status: "running",
      started_at: when(e.at),
    });
  }
}

/**
 * Running subagents' usage so far. Tokens only ever rise, by the same max() as agent_stop, so the
 * later stop for the same agent never counts twice, and the status stays whatever it is.
 */
async function applyAgentUsage(tx: Tx, e: Extract<FactoryEvent, { kind: "usage" }>) {
  for (const agent of e.agents ?? []) {
    if (agent.toolUseId) {
      await applyAgentLaunched(tx, {
        kind: "agent_launched",
        eventId: e.eventId,
        sessionId: e.sessionId,
        at: e.at,
        toolUseId: agent.toolUseId,
        agentId: agent.agentId,
      });
    }
    const existing = await byAgentId(tx, agent.agentId);
    if (!existing) {
      await tx.insert(agents).values({
        tool_use_id: pendingKey(agent.agentId),
        session_id: e.sessionId,
        agent_id: agent.agentId,
        status: "running",
        model: agent.usage.model,
        started_at: when(e.at),
        ...usageColumns(agent.usage),
      });
      continue;
    }
    await tx
      .update(agents)
      .set({
        model: existing.model ?? agent.usage.model,
        input_tokens: Math.max(existing.input_tokens, agent.usage.input),
        output_tokens: Math.max(existing.output_tokens, agent.usage.output),
        cache_read_tokens: Math.max(existing.cache_read_tokens, agent.usage.cacheRead),
        cache_write_tokens: Math.max(existing.cache_write_tokens, agent.usage.cacheWrite),
      })
      .where(eq(agents.tool_use_id, existing.tool_use_id));
  }
}

async function applyAgentStop(
  tx: Tx,
  e: Extract<FactoryEvent, { kind: "agent_stop" }>,
) {
  const existing = await byAgentId(tx, e.agentId);
  if (!existing) {
    await tx.insert(agents).values({
      tool_use_id: pendingKey(e.agentId),
      session_id: e.sessionId,
      agent_id: e.agentId,
      status: e.status,
      model: e.model ?? e.usage.model,
      started_at: when(e.at),
      ended_at: when(e.at),
      ...usageColumns(e.usage),
    });
    return;
  }
  await tx
    .update(agents)
    .set({
      status: settle(existing.status, e.status),
      ended_at: existing.ended_at ?? when(e.at),
      // The stop carries the resolved model id; the start only had the requested alias.
      model: e.model ?? existing.model,
      input_tokens: Math.max(existing.input_tokens, e.usage.input),
      output_tokens: Math.max(existing.output_tokens, e.usage.output),
      cache_read_tokens: Math.max(existing.cache_read_tokens, e.usage.cacheRead),
      cache_write_tokens: Math.max(existing.cache_write_tokens, e.usage.cacheWrite),
    })
    .where(eq(agents.tool_use_id, existing.tool_use_id));
}

const ifNewerStage = (column: string, value = `excluded."${column}"`) =>
  sql.raw(
    `case when runs."stage_at" is null or excluded."stage_at" >= runs."stage_at" then ${value} else runs."${column}" end`,
  );

/** A stage report that arrives late never overwrites a newer one. */
async function applyStage(tx: Tx, e: Extract<FactoryEvent, { kind: "stage" }>) {
  const at = when(e.at);
  await tx
    .insert(runs)
    .values({
      session_id: e.sessionId,
      started_at: at,
      last_event_at: at,
      issue_key: e.issueKey,
      branch: e.branch,
      stage: e.stage,
      stage_at: at,
      stage_summary: e.summary,
      question: e.question ?? null,
      pr_url: e.prUrl,
    })
    .onConflictDoUpdate({
      target: runs.session_id,
      set: {
        started_at: sql.raw(`least(runs."started_at", excluded."started_at")`),
        last_event_at: sql.raw(`greatest(runs."last_event_at", excluded."last_event_at")`),
        issue_key: sql.raw(`coalesce(runs."issue_key", excluded."issue_key")`),
        branch: sql.raw(`coalesce(runs."branch", excluded."branch")`),
        stage: ifNewerStage("stage"),
        stage_summary: ifNewerStage("stage_summary"),
        question: ifNewerStage("question"),
        pr_url: ifNewerStage("pr_url", `coalesce(excluded."pr_url", runs."pr_url")`),
        stage_at: sql.raw(`greatest(runs."stage_at", excluded."stage_at")`),
      },
    });
}

/** A claimed issue follows its runs' stage reports, newest first, and remembers its latest session. */
/** True for the issue's current attempt branch, so an older attempt's thread cannot move a retry. */
const onCurrentAttempt = (branch: string) =>
  sql`${branch} = case when ${issues.attempt} > 1 then 'factory/' || ${issues.key} || '-a' || ${issues.attempt} else 'factory/' || ${issues.key} end`;

async function applyToIssue(tx: Tx, event: FactoryEvent) {
  if (event.kind === "session_start") {
    const key = issueKeyFromBranch(event.branch);
    if (!key) return;
    await tx
      .update(issues)
      .set({
        session_id: event.sessionId,
        t3_thread_id: sql`coalesce(${event.t3ThreadId ?? null}, ${issues.t3_thread_id})`,
        updated_at: when(event.at),
      })
      .where(and(eq(issues.key, key), onCurrentAttempt(event.branch!)));
  }
  if (event.kind === "stage" && event.issueKey) {
    const at = when(event.at);
    await tx
      .update(issues)
      .set({
        stage: event.stage,
        stage_at: at,
        stage_summary: event.summary,
        question: event.question ?? null,
        pr_url: sql`coalesce(${event.prUrl ?? null}, ${issues.pr_url})`,
        stage_event_id: event.eventId,
        updated_at: at,
      })
      .where(
        and(
          eq(issues.key, event.issueKey),
          or(isNull(issues.stage_at), lte(issues.stage_at, at)),
          // Reports from a thread carry its branch; the runner's own events target the current attempt.
          // A failed attempt stays failed: a stopped or timed-out thread that reports again does not revive it.
          ...(event.branch ? [onCurrentAttempt(event.branch), ne(issues.stage, "failed")] : []),
        ),
      );
  }
}

async function project(tx: Tx, event: FactoryEvent) {
  await applyToIssue(tx, event);
  if (event.kind === "stage") return applyStage(tx, event);
  await upsertRun(tx, event);
  switch (event.kind) {
    case "agent_start":
      return applyAgentStart(tx, event);
    case "agent_launched":
      return applyAgentLaunched(tx, event);
    case "agent_stop":
      return applyAgentStop(tx, event);
    case "usage":
      return applyAgentUsage(tx, event);
    default:
      return;
  }
}

export type IngestResult = {
  received: number;
  inserted: number;
  /** USD spent so far per factory branch (one attempt at an issue) touched by the batch; the reporter caches it for the budget hook. */
  spend: Record<string, number>;
};

/**
 * Appends events and applies projections in one transaction. Events that were
 * already stored are skipped, so a retried batch changes nothing.
 */
export async function ingest(
  db: Db,
  batch: FactoryEvent[],
): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    // Projections read-then-write agent rows, so one session is handled by one batch at a time.
    const sessionIds = [...new Set(batch.map((e) => e.sessionId))].sort();
    for (const id of sessionIds) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${id}))`);
    }

    const stored = await tx
      .insert(events)
      .values(
        batch.map((e) => ({
          event_id: e.eventId,
          session_id: e.sessionId,
          kind: e.kind,
          at: when(e.at),
          issue_key: e.kind === "stage" ? e.issueKey : undefined,
          payload: e,
        })),
      )
      .onConflictDoNothing({ target: events.event_id })
      .returning({ event_id: events.event_id });

    const fresh = new Set(stored.map((row) => row.event_id));
    for (const event of batch) {
      if (!fresh.delete(event.eventId)) continue;
      await project(tx, event);
    }
    const branches = await tx
      .selectDistinct({ branch: runs.branch })
      .from(runs)
      .where(and(inArray(runs.session_id, sessionIds), isNotNull(runs.issue_key), isNotNull(runs.branch)));
    const spend = await branchSpend(tx, branches.map((b) => b.branch!));
    return { received: batch.length, inserted: stored.length, spend };
  });
}
