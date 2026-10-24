import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { agents, events, jobs, runs } = await import("../db/schema");
const { ingest } = await import("../lib/ingest");
const { eventSchema } = await import("../lib/events");
const { linearJob } = await import("./fixtures");

const run = `regress-${Date.now()}`;
// Keys no real job can have: a regression must never touch a live job or its runs.
const key = `REGRESS-${Date.now() % 1_000_000}`;
const otherKey = `REGRESSB-${Date.now() % 1_000_000}`;
const t0 = Date.now() - 60_000;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: "claude-sonnet-5-5" };
const ev = (n: number, body: Record<string, unknown>) =>
  eventSchema.parse({ sessionId: run, eventId: `${run}-${n}`, ...body });

const jobKey = `REG-${Date.now()}`;
await db.insert(jobs).values(linearJob(run, jobKey, { claimed_at: new Date(t0), updated_at: new Date(t0) }));
const jobRow = async () => (await db.select().from(jobs).where(eq(jobs.key, jobKey)))[0]!;

try {
  await ingest(db, [
    ev(1, { kind: "session_start", at: t0, cwd: "/tmp/x", branch: `factory/${key}`, transcriptPath: "/tmp/x/t.jsonl" }),
    ev(2, { kind: "turn_stop", at: t0 + 10_000, usage }),
    ev(3, { kind: "agent_stop", at: t0 + 11_000, agentId: `${run}-bg`, status: "completed", usage }),
  ]);
  const [r] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(r.status, "idle", "a background agent finishing after the turn keeps the run idle");
  assert.equal(r.transcript_path, "/tmp/x/t.jsonl", "the run records its transcript path");

  await ingest(db, [
    ev(4, { kind: "agent_stop", at: t0 + 20_000, agentId: `${run}-a`, status: "completed", usage, model: "claude-haiku-5-5" }),
    ev(5, { kind: "agent_launched", at: t0 + 20_100, toolUseId: `${run}-tu`, agentId: `${run}-a` }),
  ]);
  await ingest(db, [
    ev(6, { kind: "agent_start", at: t0 + 15_000, toolUseId: `${run}-tu`, subagentType: "Explore", description: "late", model: "haiku" }),
  ]);
  const [a] = await db.select().from(agents).where(eq(agents.tool_use_id, `${run}-tu`));
  assert.equal(a.model, "claude-haiku-5-5", "a late agent_start keeps the resolved model id");
  assert.equal(a.status, "completed", "a late agent_start keeps the agent completed");

  await ingest(db, [
    ev(7, { kind: "stage", at: t0 + 30_000, stage: "implementing", summary: "red test in", jobKey: key }),
    ev(8, { kind: "stage", at: t0 + 40_000, stage: "pr", summary: "opened", prUrl: "https://github.com/x/y/pull/1" }),
    ev(9, { kind: "turn_stop", at: t0 + 41_000, usage }),
  ]);
  await ingest(db, [
    ev(10, { kind: "stage", at: t0 + 35_000, stage: "verifying", summary: "late" }),
  ]);
  const [s] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(s.stage, "pr", "a late stage report does not move the stage back");
  assert.equal(s.stage_summary, "opened", "a late stage report keeps the newer summary");
  assert.equal(s.pr_url, "https://github.com/x/y/pull/1");
  assert.equal(s.job_key, key, "the stage report's job key fills a run that had none");
  await ingest(db, [ev(17, { kind: "stage", at: t0 + 30_500, stage: "triage", summary: "s", jobKey: otherKey, branch: `factory/${otherKey}-a2`, sessionId: `${run}-b` })]);
  const [b] = await db.select().from(runs).where(eq(runs.session_id, `${run}-b`));
  assert.equal(b.branch, `factory/${otherKey}-a2`, "a run first seen through a stage report keeps its branch");
  assert.equal(s.status, "idle", "stage reports leave the status alone");

  const bigUsage = { ...usage, input: 1_000_000, output: 2 };
  const result = await ingest(db, [ev(20, { kind: "usage", at: t0 + 42_000, usage: bigUsage })]);
  const [u] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(u.input_tokens, 1_000_000, "a usage snapshot raises the run's tokens mid-turn");
  assert.equal(u.status, "idle", "a usage snapshot leaves the status alone");
  assert.ok((result.spend[`factory/${key}`] ?? 0) >= 2, "ingest answers with the spend of the branch, one attempt at the job");

  const subUsage = { ...usage, input: 500_000, model: "claude-sonnet-5-5" };
  const before = result.spend[`factory/${key}`]!;
  const running = await ingest(db, [
    ev(21, { kind: "usage", at: t0 + 43_000, usage: bigUsage, agents: [{ agentId: `${run}-sub`, toolUseId: `${run}-tu-sub`, usage: subUsage }] }),
  ]);
  const [sub] = await db.select().from(agents).where(eq(agents.agent_id, `${run}-sub`));
  assert.equal(sub.status, "running", "a subagent seen only in a usage snapshot stays running");
  assert.equal(sub.tool_use_id, `${run}-tu-sub`, "the snapshot links the agent to its Agent tool call");
  assert.ok(running.spend[`factory/${key}`]! > before + 0.9, "a running subagent counts toward the job's spend");
  const stopped = await ingest(db, [
    ev(22, { kind: "agent_stop", at: t0 + 44_000, agentId: `${run}-sub`, status: "completed", usage: subUsage }),
  ]);
  assert.equal(stopped.spend[`factory/${key}`], running.spend[`factory/${key}`], "its SubagentStop does not count it twice");

  await ingest(db, [
    ev(11, { kind: "stage", at: t0 + 50_000, stage: "waiting", summary: "blocked", question: "Which breakpoint?" }),
  ]);
  const [w] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(w.question, "Which breakpoint?");
  assert.equal(w.pr_url, "https://github.com/x/y/pull/1", "a later stage without a PR keeps the PR link");

  await ingest(db, [
    ev(12, { kind: "session_start", at: t0 + 60_000, cwd: "/tmp/x", branch: `factory/${jobKey}`, t3ThreadId: "thread-1" }),
    ev(13, { kind: "stage", at: t0 + 62_000, stage: "pr", summary: "opened", prUrl: "https://github.com/x/y/pull/2", jobKey }),
  ]);
  const moved = await jobRow();
  assert.equal(moved.stage, "pr", "a stage event with jobKey moves the jobs row");
  assert.equal(moved.stage_event_id, `${run}-13`, "the job remembers the event its stage came from");
  await ingest(db, [
    ev(14, { kind: "stage", at: t0 + 61_000, stage: "implementing", summary: "late", jobKey }),
  ]);
  await db.update(jobs).set({ attempt: 2 }).where(eq(jobs.key, jobKey));
  await ingest(db, [
    ev(15, { kind: "stage", at: t0 + 63_000, stage: "failed", summary: "old thread", jobKey, branch: `factory/${jobKey}` }),
    ev(16, { kind: "session_start", at: t0 + 63_500, cwd: "/tmp/x", branch: `factory/${jobKey}`, t3ThreadId: "old" }),
  ]);
  const kept = await jobRow();
  assert.equal(kept.stage, "pr", "a report from an earlier attempt's branch does not move the retry");
  assert.equal(kept.t3_thread_id, "thread-1", "nor does its session start");
  await db.update(jobs).set({ attempt: 1, stage: "failed" }).where(eq(jobs.key, jobKey));
  const failed = await jobRow();
  await ingest(db, [
    ev(18, { kind: "stage", at: t0 + 64_000, stage: "pr", summary: "late", jobKey, branch: `factory/${jobKey}` }),
    { ...ev(19, { kind: "stage", at: t0 + 65_000, stage: "queued", summary: "resumed", jobKey }), eventId: `resume:${run}:c-1` },
    { ...ev(23, { kind: "stage", at: t0 + 66_000, stage: "implementing", summary: "conflict", jobKey }), eventId: `conflict:${run}:h1` },
  ]);
  assert.deepEqual(await jobRow(), failed, "a stage after failed, without a reclaim, leaves the row unchanged");
  await ingest(db, [
    { ...ev(24, { kind: "stage", at: t0 + 67_000, stage: "merged", summary: "Merged", prUrl: "https://github.com/x/y/pull/2", jobKey }), eventId: `merged:https://github.com/x/y/pull/2:${run}` },
  ]);
  assert.equal((await jobRow()).stage, "merged", "a PR a human merged after the attempt failed still marks the job merged");
  const merged = await jobRow();
  await ingest(db, [{ ...ev(25, { kind: "stage", at: t0 + 68_000, stage: "failed", summary: "late", jobKey }), eventId: `watchdog:${run}:1:x` }]);
  assert.deepEqual(await jobRow(), merged, "merged is final");

  const i = await jobRow();
  assert.equal(i.pr_url, "https://github.com/x/y/pull/2");
  assert.equal(i.t3_thread_id, "thread-1", "session_start on the job branch links the T3 thread");
  assert.equal(i.session_id, run);

  const old = eventSchema.safeParse({ sessionId: run, eventId: `${run}-old`, kind: "stage", at: t0, stage: "triage", summary: "s", issueKey: jobKey });
  assert.equal(old.success, false, "a stage event with the old issueKey field is refused");
  assert.match(JSON.stringify(old.error?.issues), /issueKey was renamed to jobKey/, "and the error names jobKey");

  console.log("ingest regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(eq(jobs.external_id, run));
  await db.delete(agents).where(eq(agents.session_id, run));
  await db.delete(runs).where(inArray(runs.session_id, [run, `${run}-b`]));
  await db.delete(events).where(inArray(events.session_id, [run, `${run}-b`]));
  process.exit(process.exitCode ?? 0);
}
