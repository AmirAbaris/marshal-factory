import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { agents, events, jobEvidence, jobs, jobScreenshots, runs } from "../db/schema";
import type { FactoryEvent, Usage } from "./events";
import { summarize } from "./evidence";
import { normalizeAssessment } from "./assessment";
import { attemptBranchSql } from "./branch-sql";
import { parseBranch } from "./factory";
import { isFinished } from "./archive";
import { branchSpend } from "./spend";
import { decideStage, type StageVerdict } from "./stages";

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
  evidence: null,
  screenshot: null,
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

/** "unknown" is what a reader says before it has seen a model; it never replaces one. */
const knownModel = (model: string | null | undefined) => (model && model !== "unknown" ? model : undefined);

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
          job_key: parseBranch(event.branch)?.key,
          t3_thread_id: event.t3ThreadId,
          title: event.title,
          model: event.model,
        }
      : event.kind === "turn_stop" || event.kind === "usage"
        ? { model: knownModel(event.usage.model), ...usageColumns(event.usage) }
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
                `case when excluded."last_event_at" >= runs."last_event_at" and (runs."stage" is null or runs."stage" not in ('merged', 'failed')) then excluded."status" else runs."status" end`,
              ),
            }
          : {}),
        ...Object.fromEntries(
          ["cwd", "repo", "branch", "job_key", "t3_thread_id", "title", "model", "transcript_path"]
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
        model: knownModel(agent.usage.model),
        started_at: when(e.at),
        ...usageColumns(agent.usage),
      });
      continue;
    }
    await tx
      .update(agents)
      .set({
        model: knownModel(existing.model) ?? knownModel(agent.usage.model) ?? existing.model,
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
  const end = isFinished(e.stage);
  await tx
    .insert(runs)
    .values({
      session_id: e.sessionId,
      started_at: at,
      last_event_at: at,
      job_key: e.jobKey,
      branch: e.branch,
      stage: e.stage,
      stage_at: at,
      stage_summary: e.summary,
      question: e.question ?? null,
      pr_url: e.prUrl,
      status: end ? "ended" : "active",
    })
    .onConflictDoUpdate({
      target: runs.session_id,
      set: {
        started_at: sql.raw(`least(runs."started_at", excluded."started_at")`),
        last_event_at: sql.raw(`greatest(runs."last_event_at", excluded."last_event_at")`),
        job_key: sql.raw(`coalesce(runs."job_key", excluded."job_key")`),
        branch: sql.raw(`coalesce(runs."branch", excluded."branch")`),
        stage: ifNewerStage("stage"),
        stage_summary: ifNewerStage("stage_summary"),
        question: ifNewerStage("question"),
        pr_url: ifNewerStage("pr_url", `coalesce(excluded."pr_url", runs."pr_url")`),
        stage_at: sql.raw(`greatest(runs."stage_at", excluded."stage_at")`),
        status: sql.raw(
          `case when (runs."stage_at" is null or excluded."stage_at" >= runs."stage_at") and excluded."stage" in ('merged', 'failed') then 'ended' else runs."status" end`,
        ),
      },
    });
}

async function linkSession(tx: Tx, event: Extract<FactoryEvent, { kind: "session_start" }>) {
  const key = parseBranch(event.branch)?.key;
  if (!key) return;
  await tx
    .update(jobs)
    .set({
      session_id: event.sessionId,
      t3_thread_id: sql`coalesce(${event.t3ThreadId ?? null}, ${jobs.t3_thread_id})`,
      updated_at: when(event.at),
    })
    // Only the job's current attempt branch, so an older attempt's thread cannot move a retry.
    .where(and(eq(jobs.key, key), eq(attemptBranchSql, event.branch!)));
}

/** Moves the claimed job the event names; undefined when it names none. */
async function moveJob(tx: Tx, event: Extract<FactoryEvent, { kind: "stage" }>): Promise<StageVerdict | undefined> {
  if (!event.jobKey) return;
  const [job] = await tx.select().from(jobs).where(eq(jobs.key, event.jobKey)).for("update");
  if (!job) return;
  const at = when(event.at);
  const verdict = decideStage(job, { stage: event.stage, at, eventId: event.eventId, branch: event.branch });
  if (verdict.outcome !== "apply") return verdict;
  await tx
    .update(jobs)
    .set({
      stage: event.stage,
      stage_at: at,
      stage_summary: event.summary,
      question: event.question ?? null,
      pr_url: sql`coalesce(${event.prUrl ?? null}, ${jobs.pr_url})`,
      // Each pr report replaces the assessment, so the latest report on this attempt wins.
      ...(event.stage === "pr" && { merge_assessment: event.assessment ? normalizeAssessment(event.assessment) : null, assessment_event_id: event.eventId }),
      stage_event_id: event.eventId,
      updated_at: at,
    })
    .where(eq(jobs.id, job.id));
  if (isFinished(event.stage)) {
    await tx.update(runs).set({ status: "ended" }).where(eq(runs.job_key, event.jobKey));
  }
  return verdict;
}

/**
 * Keeps the latest evidence per job and commit; a dirty run never replaces a clean one at the same
 * commit. The job's summary follows its newest row for the current attempt. Evidence opens no run.
 */
async function applyEvidence(tx: Tx, e: Extract<FactoryEvent, { kind: "evidence" }>) {
  const at = when(e.at);
  await tx
    .insert(jobEvidence)
    .values({ job_key: e.jobKey, sha: e.sha, attempt: e.attempt, repo: e.repo, clean: e.clean, producer: e.producer, source: e.source, checks: e.checks, event_id: e.eventId, recorded_at: at })
    .onConflictDoUpdate({
      target: [jobEvidence.job_key, jobEvidence.sha],
      set: {
        attempt: sql`excluded.attempt`,
        repo: sql`excluded.repo`,
        clean: sql`excluded.clean`,
        producer: sql`excluded.producer`,
        source: sql`excluded.source`,
        checks: sql`excluded.checks`,
        event_id: sql`excluded.event_id`,
        recorded_at: sql`excluded.recorded_at`,
      },
      setWhere: sql`excluded.recorded_at >= ${jobEvidence.recorded_at} and (excluded.clean or not ${jobEvidence.clean})`,
    });
  const [job] = await tx.select({ id: jobs.id, attempt: jobs.attempt }).from(jobs).where(eq(jobs.key, e.jobKey)).for("update");
  if (!job || job.attempt !== e.attempt) return;
  const [latest] = await tx
    .select()
    .from(jobEvidence)
    .where(and(eq(jobEvidence.job_key, e.jobKey), eq(jobEvidence.attempt, e.attempt)))
    .orderBy(desc(jobEvidence.recorded_at))
    .limit(1);
  if (latest) await tx.update(jobs).set({ evidence: summarize(latest, latest.recorded_at) }).where(eq(jobs.id, job.id));
}

/** Stores one attached image; a redelivered event changes nothing. Screenshots open no run. */
async function applyScreenshot(tx: Tx, e: Extract<FactoryEvent, { kind: "screenshot" }>) {
  await tx
    .insert(jobScreenshots)
    .values({ stage_event_id: e.stageEventId, file: e.file, job_key: e.jobKey, content_type: e.contentType, bytes: Buffer.from(e.data, "base64"), event_id: e.eventId, recorded_at: when(e.at) })
    .onConflictDoNothing();
}

/** The event as the log keeps it: an image's bytes live in job_screenshots only. */
const logged = (e: FactoryEvent): FactoryEvent => (e.kind === "screenshot" ? { ...e, data: "" } : e);

export type StageRefusal = { eventId: string; reason: string };

async function project(tx: Tx, event: FactoryEvent): Promise<StageRefusal | undefined> {
  if (event.kind === "evidence") {
    await applyEvidence(tx, event);
    return;
  }
  if (event.kind === "screenshot") {
    await applyScreenshot(tx, event);
    return;
  }
  if (event.kind !== "stage") {
    if (event.kind === "session_start") await linkSession(tx, event);
    await upsertRun(tx, event);
    await applyAgentEvent(tx, event);
    return;
  }
  const verdict = await moveJob(tx, event);
  if (verdict?.outcome === "refuse") {
    await tx.update(events).set({ refusal: verdict.reason }).where(eq(events.event_id, event.eventId));
    return { eventId: event.eventId, reason: verdict.reason };
  }
  await applyStage(tx, event);
}

async function applyAgentEvent(tx: Tx, event: FactoryEvent) {
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
  /** USD spent so far per factory branch (one attempt at a job) touched by the batch; reporters from before the budget cap was removed still cache it. */
  spend: Record<string, number>;
  /** Stage events the transition table refused; stored, but neither the job nor the run moved. */
  refused: StageRefusal[];
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
          job_key: e.kind === "stage" || e.kind === "evidence" || e.kind === "screenshot" ? e.jobKey : undefined,
          payload: logged(e),
        })),
      )
      .onConflictDoNothing({ target: events.event_id })
      .returning({ event_id: events.event_id });

    const fresh = new Set(stored.map((row) => row.event_id));
    const refused: StageRefusal[] = [];
    for (const event of batch) {
      if (!fresh.delete(event.eventId)) continue;
      const refusal = await project(tx, event);
      if (refusal) refused.push(refusal);
    }
    const branches = await tx
      .selectDistinct({ branch: runs.branch })
      .from(runs)
      .where(and(inArray(runs.session_id, sessionIds), isNotNull(runs.job_key), isNotNull(runs.branch)));
    const spend = await branchSpend(tx, branches.map((b) => b.branch!));
    return { received: batch.length, inserted: stored.length, spend, refused };
  });
}
