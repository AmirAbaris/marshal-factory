import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { agents, events, issues, runs } = await import("../db/schema");
const { ingest } = await import("../lib/ingest");
const { eventSchema } = await import("../lib/events");

const run = `regress-${Date.now()}`;
const t0 = Date.now() - 60_000;
const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, model: "claude-sonnet-5-5" };
const ev = (n: number, body: Record<string, unknown>) =>
  eventSchema.parse({ sessionId: run, eventId: `${run}-${n}`, ...body });

const issueKey = `REG-${Date.now()}`;
await db.insert(issues).values({
  linear_id: run,
  key: issueKey,
  title: "regression issue",
  url: "https://linear.app/x",
  claimed_at: new Date(t0),
  updated_at: new Date(t0),
});

try {
  await ingest(db, [
    ev(1, { kind: "session_start", at: t0, cwd: "/tmp/x", transcriptPath: "/tmp/x/t.jsonl" }),
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
    ev(7, { kind: "stage", at: t0 + 30_000, stage: "implementing", summary: "red test in", issueKey: "FAC-9" }),
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
  assert.equal(s.issue_key, "FAC-9", "the stage report's issue key fills a run that had none");
  assert.equal(s.status, "idle", "stage reports leave the status alone");

  const bigUsage = { ...usage, input: 1_000_000, output: 2 };
  const result = await ingest(db, [ev(20, { kind: "usage", at: t0 + 42_000, usage: bigUsage })]);
  const [u] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(u.input_tokens, 1_000_000, "a usage snapshot raises the run's tokens mid-turn");
  assert.equal(u.status, "idle", "a usage snapshot leaves the status alone");
  assert.ok((result.spend["FAC-9"] ?? 0) >= 2, "ingest answers with the issue's spend");

  await ingest(db, [
    ev(11, { kind: "stage", at: t0 + 50_000, stage: "waiting", summary: "blocked", question: "Which breakpoint?" }),
  ]);
  const [w] = await db.select().from(runs).where(eq(runs.session_id, run));
  assert.equal(w.question, "Which breakpoint?");
  assert.equal(w.pr_url, "https://github.com/x/y/pull/1", "a later stage without a PR keeps the PR link");

  await ingest(db, [
    ev(12, { kind: "session_start", at: t0 + 60_000, cwd: "/tmp/x", branch: `factory/${issueKey}`, t3ThreadId: "thread-1" }),
    ev(13, { kind: "stage", at: t0 + 62_000, stage: "pr", summary: "opened", prUrl: "https://github.com/x/y/pull/2", issueKey }),
  ]);
  await ingest(db, [
    ev(14, { kind: "stage", at: t0 + 61_000, stage: "implementing", summary: "late", issueKey }),
  ]);
  const [i] = await db.select().from(issues).where(eq(issues.key, issueKey));
  assert.equal(i.stage, "pr", "a late stage report does not move the issue back");
  assert.equal(i.stage_event_id, `${run}-13`, "the issue remembers the event its stage came from");
  assert.equal(i.pr_url, "https://github.com/x/y/pull/2");
  assert.equal(i.t3_thread_id, "thread-1", "session_start on the issue branch links the T3 thread");
  assert.equal(i.session_id, run);

  console.log("ingest regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(issues).where(eq(issues.linear_id, run));
  await db.delete(agents).where(eq(agents.session_id, run));
  await db.delete(runs).where(eq(runs.session_id, run));
  await db.delete(events).where(inArray(events.session_id, [run]));
  process.exit(process.exitCode ?? 0);
}
