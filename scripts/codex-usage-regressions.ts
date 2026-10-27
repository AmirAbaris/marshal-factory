import "./test-guard";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { fake, FakeSandbox, fakeModal, sandboxes } from "./fake-modal";

const { db } = await import("../db/client");
const { agents, events, jobs, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts, localHost } = await import("../lib/host");
const { modal, modalHost } = await import("../lib/modal-host");
const { CODEX_HOME } = await import("../lib/sandbox");
const { codexUsage, matchRollouts, parseRollout, readRollouts, ROLLOUT_SLACK_MS } = await import("../lib/codex-usage");
const { costKnown, costUsd, knownCostUsd, priceFor } = await import("../lib/pricing");
const { branchCosts } = await import("../lib/spend");
const { config, enforceBudget, ingestClient, reconcileUsage } = await import("../runner/ops");
const { teardownSandbox } = await import("../runner/lifecycle");

const FIXTURES = join(import.meta.dirname, "fixtures/codex");
const DAY = join(FIXTURES, "sessions/2026/10/27");
const fixture = (thread: string) => readFileSync(join(DAY, readdirSync(DAY).find((f) => f.endsWith(`${thread}.jsonl`))!), "utf8");
const ROOT = "019a2b3c-0000-7000-8000-000000000001";
const SUB = "019a2b3c-0000-7000-8000-000000000002";
const OTHER = "019a2b3c-0000-7000-8000-000000000003";
const BARE = "019a2b3c-0000-7000-8000-000000000004";
const WORKTREE = "/root/.t3/worktrees/factory-demo/factory-FAC-61";
const RUN_START = Date.parse("2026-10-27T10:05:00.000Z");

// --- the rollout parser
const root = parseRollout(fixture(ROOT))!;
assert.deepEqual(
  root,
  {
    threadId: ROOT,
    sessionId: ROOT,
    parentThreadId: null,
    cwd: WORKTREE,
    branch: "factory/FAC-61",
    startedAt: Date.parse("2026-10-27T10:00:00.000Z"),
    lastUsageAt: Date.parse("2026-10-27T10:04:00.000Z"),
    // 30000 input, of it 21000 cached and 1000 cache writes; reasoning is inside the 2500 output.
    usage: { input: 8000, output: 2500, cacheRead: 21000, cacheWrite: 1000, model: "gpt-6.1-sol" },
  },
  "the last running total counts, past a bad line, a null count and prose naming the event types",
);
const sub = parseRollout(fixture(SUB))!;
assert.deepEqual([sub.sessionId, sub.parentThreadId, sub.usage], [ROOT, ROOT, { input: 2000, output: 400, cacheRead: 3000, cacheWrite: 0, model: "gpt-6-luna" }], "a subagent shares its root's session; a missing field counts 0");
const bare = parseRollout(fixture(BARE))!;
assert.deepEqual([bare.cwd, bare.branch, bare.startedAt, bare.lastUsageAt, bare.usage], [null, null, null, null, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, model: "unknown" }], "missing metadata and model stay unknown");
assert.equal(parseRollout(fixture(ROOT).split("\n").slice(1).join("\n")), undefined, "no session_meta, no rollout");
const reordered = fixture(ROOT).split("\n").reverse().join("\n");
assert.equal(parseRollout(reordered)!.usage.input, 8000, "the largest total wins whatever the line order");

// --- matching
const all = [root, sub, parseRollout(fixture(OTHER))!, bare];
const run = { cwd: WORKTREE, branch: "factory/FAC-61", startedAt: RUN_START };
assert.deepEqual(matchRollouts(all, run).map((r) => r.threadId), [ROOT, SUB], "the worktree's root and its subagent");
assert.deepEqual(matchRollouts(all, { ...run, cwd: null }).map((r) => r.threadId), [ROOT, SUB], "the attempt branch alone finds it");
assert.deepEqual(matchRollouts(all, { ...run, cwd: "/root/.t3/worktrees/factory-demo/factory-FAC-6", branch: null }).map((r) => r.threadId), [], "a worktree whose path only starts the same is another one");
assert.deepEqual(matchRollouts([{ ...root, cwd: `${WORKTREE}/packages/app` }], { ...run, branch: null }).length, 1, "a directory inside the worktree is");
assert.deepEqual(matchRollouts(all, { ...run, startedAt: root.startedAt! + ROLLOUT_SLACK_MS + 1 }), [], "a root that started well before the run is an earlier one's");
assert.deepEqual(matchRollouts([root, { ...root, usage: { ...root.usage, input: 10 } }], run).map((r) => r.usage.input), [8000], "a thread read twice counts once, at its largest");
const relaunched = { ...root, threadId: "r2", sessionId: "r2", startedAt: root.startedAt! + 60_000, usage: { ...root.usage, model: "gpt-6-astra" } };
const both = codexUsage([root, sub, relaunched], run)!;
assert.deepEqual([both.main.threadId, both.others.map((r) => r.threadId)], ["r2", [ROOT, SUB]], "the newest root is the run's; older roots and subagents count apart, each on its model");
assert.equal(codexUsage(all, { ...run, cwd: "/elsewhere", branch: "factory/FAC-7" }), undefined);

// --- pricing
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite });
assert.equal(knownCostUsd(tokens(1_000_000, 1_000_000, 1_000_000, 1_000_000), "gpt-6.1-sol"), 2 + 10 + 0.1 + 2.5, "cached input and cache writes are priced apart");
assert.equal(knownCostUsd(tokens(1_000_000, 0), "gpt-6-astra-2026-09-01"), 10, "a dated snapshot takes its model's price");
assert.equal(priceFor("gpt-6-sol-mini"), undefined, "a longer name is another model");
assert.equal(priceFor("gpt-6.1-sol")?.cacheRead, 0.1, "gpt-6.1-sol is not gpt-6-sol");
assert.equal(knownCostUsd(tokens(1_000, 0), "gpt-9-nova"), undefined, "an unknown model has an unknown cost");
assert.equal(costUsd(tokens(1_000, 0), "gpt-9-nova"), 0, "and the panel counts it as 0");
assert.equal(knownCostUsd(tokens(0, 0), "gpt-9-nova"), 0, "no tokens cost nothing, whatever the model");
assert.equal(knownCostUsd(tokens(1_000_000, 0), "gpt-9-nova", { "gpt-9": { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 } }), undefined, "an override prices only its own name");
assert.equal(knownCostUsd(tokens(1_000_000, 0), "gpt-9-nova", { "gpt-9-nova": { input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 } }), 3, "an override prices a model with no default");
assert.equal(knownCostUsd(tokens(1_000_000, 0), "gpt-6.1-sol", { "gpt-6.1-sol": null }), undefined, "null makes a priced model unknown");
assert.equal(knownCostUsd(tokens(1_000_000, 0), "claude-opus-5-5"), 4, "Claude keeps its prices");
const row = (model: string | null, t = tokens(1_000, 100)) => ({ ...t, model });
assert.equal(costKnown([row("gpt-6.1-sol"), row("gpt-6-luna")]), true);
assert.equal(costKnown([row("gpt-6.1-sol"), row(null)]), false, "one unpriced row makes it unknown");
assert.equal(costKnown([row(null, tokens(0, 0))]), false, "nothing recorded is unknown");

// --- the runner, against a fake sandbox whose Codex home is a copy of the fixtures
modal.api = fakeModal;
const home = mkdtempSync(join(tmpdir(), "codex-usage-"));
cpSync(FIXTURES, home, { recursive: true });
const homeRead = await readRollouts(localHost, home, RUN_START - ROLLOUT_SLACK_MS);
assert.deepEqual(homeRead.map((r) => r.threadId).sort(), [ROOT, SUB, OTHER, BARE].sort(), "the host command reads every recent rollout");
assert.deepEqual(homeRead.find((r) => r.threadId === ROOT)!.usage, root.usage, "and the lines it keeps parse like the whole file");
assert.deepEqual(await readRollouts(localHost, join(home, "missing"), Date.now() - 60_000), [], "no sessions dir, no rollouts");

fake.answer = (_sandbox, argv) => {
  if (argv[0] !== "sh") return {};
  const args = argv.slice(1).map((a) => (a.startsWith(CODEX_HOME) ? home + a.slice(CODEX_HOME.length) : a));
  const result = spawnSync("sh", args, { encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
};
hosts.sandbox = modalHost;
ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);

const stamp = Date.now() % 1_000_000;
const KEY = `CXU-${stamp}`;
const OVER = `CXO-${stamp}`;
const UNPRICED = `CXN-${stamp}`;
const SANDBOX = `sb-codex-usage-${stamp}`;
const SESSION = `mcp:factory/${KEY}`;
const keys = [KEY, OVER, UNPRICED];
const jobRow = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const runRow = async () => (await db.select().from(runs).where(eq(runs.session_id, SESSION)))[0]!;
const agentRows = async () => db.select().from(agents).where(eq(agents.session_id, SESSION));

try {
  sandboxes.set(SANDBOX, new FakeSandbox(SANDBOX));
  await db.insert(jobs).values(linearJob(`codex-usage-${KEY}`, KEY, { machine_id: TEST_MACHINE_ID, provider: "codex", model: "gpt-6.1-sol", execution: "modal", stage: "pr", sandbox_id: SANDBOX }));
  // The MCP server's session_start: the run, its worktree and branch, no usage.
  await ingest(db, [eventSchema.parse({ kind: "session_start", eventId: `mcp-start:${SESSION}`, sessionId: SESSION, at: RUN_START, cwd: WORKTREE, branch: `factory/${KEY}` })]);
  await db.update(runs).set({ last_event_at: new Date() }).where(eq(runs.session_id, SESSION));
  const lastEventAt = (await runRow()).last_event_at.getTime();

  assert.deepEqual(await reconcileUsage({ only: [KEY] }), [KEY], "the pass records the Codex run's usage");
  const recorded = await runRow();
  assert.deepEqual(
    [recorded.model, recorded.input_tokens, recorded.output_tokens, recorded.cache_read_tokens, recorded.cache_write_tokens],
    ["gpt-6.1-sol", 8000, 2500, 21000, 1000],
    "into the run's usage columns, like Claude's",
  );
  assert.equal(recorded.last_event_at.getTime(), lastEventAt, "a usage read is not activity");
  assert.deepEqual((await agentRows()).map((a) => [a.agent_id, a.model, a.input_tokens, a.cache_read_tokens]), [[`codex:${SUB}`, "gpt-6-luna", 2000, 3000]], "the subagent gets its own row");
  assert.deepEqual(await reconcileUsage({ only: [KEY] }), [], "nothing new, nothing posted");
  const cost = (await branchCosts(db, [`factory/${KEY}`]))[`factory/${KEY}`]!;
  assert.equal(cost.known, true);
  assert.ok(Math.abs(cost.usd - (8000 * 2 + 2500 * 10 + 21000 * 0.1 + 1000 * 2.5 + 2000 * 0.1 + 400 * 0.5 + 3000 * 0.01) / 1e6) < 1e-12, `the attempt's cost is priced per model: ${cost.usd}`);

  // More work lands after the last pass; the teardown reads it before the sandbox goes.
  const rootFile = join(home, "sessions/2026/10/27", readdirSync(join(home, "sessions/2026/10/27")).find((f) => f.endsWith(`${ROOT}.jsonl`))!);
  const total = { input_tokens: 50_000, cached_input_tokens: 30_000, cache_write_input_tokens: 1000, output_tokens: 4000, reasoning_output_tokens: 2000, total_tokens: 54_000 };
  appendFileSync(rootFile, `${JSON.stringify({ timestamp: "2026-10-27T10:30:00.000Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: total } } })}\n`);
  await db.update(jobs).set({ stage: "merged" }).where(eq(jobs.key, KEY));
  await teardownSandbox(await jobRow(KEY));
  const final = await runRow();
  assert.deepEqual([final.input_tokens, final.output_tokens, final.cache_read_tokens], [19_000, 4000, 30_000], "the last usage is recorded before teardown");
  assert.equal((await jobRow(KEY)).sandbox_id, null, "and the sandbox is gone");
  assert.ok(sandboxes.get(SANDBOX)!.terminated);

  // A sandbox that is gone has no rollouts left: the pass skips its run and goes on.
  await db.update(jobs).set({ sandbox_id: SANDBOX }).where(eq(jobs.key, KEY));
  assert.deepEqual(await reconcileUsage({ only: [KEY] }), [], "a gone sandbox does not abort the pass");

  // The budget: a Codex attempt with a known cost over its cap fails; an unpriced one is left to the merge decision.
  for (const k of [OVER, UNPRICED]) await db.insert(jobs).values(linearJob(`codex-usage-${k}`, k, { machine_id: TEST_MACHINE_ID, provider: "codex", stage: "implementing", budget_usd: 5 }));
  await db.insert(runs).values({ ...usageRun(OVER, "gpt-6-astra", { output: 1_000_000 }), session_id: `mcp:factory/${OVER}` });
  await db.insert(runs).values({ ...usageRun(UNPRICED, "gpt-9-nova", { output: 1_000_000 }), session_id: `mcp:factory/${UNPRICED}` });
  const over = await enforceBudget();
  assert.ok(over.includes(OVER), `the Codex run over budget fails: ${JSON.stringify(over)}`);
  assert.ok(!over.includes(UNPRICED), "an unpriced one isn't failed on a guess");
  assert.equal((await jobRow(OVER)).stage, "failed");
  assert.match((await jobRow(OVER)).stage_summary ?? "", /budget exceeded \(\$50\.15 of \$5\.00\)/);
  config.factory.pricing = { "gpt-9-nova": { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 1 } };
  assert.ok((await enforceBudget()).includes(UNPRICED), "factory.pricing prices it, and then the cap holds");
  config.factory.pricing = {};

  console.log("codex usage regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(agents).where(like(agents.session_id, `mcp:factory/CX%${stamp}%`));
  await db.delete(runs).where(inArray(runs.job_key, keys));
  await db.delete(events).where(inArray(events.job_key, keys));
  await db.delete(events).where(like(events.session_id, `mcp:factory/CX%${stamp}%`));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "codex-usage-")}%`));
  rmSync(home, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
