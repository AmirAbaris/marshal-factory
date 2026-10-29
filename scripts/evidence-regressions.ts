import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import type { MergeAssessment } from "../lib/assessment";
import type { EvidenceCheck } from "../lib/evidence";
import type { FactoryEvent } from "../lib/events";

const { db } = await import("../db/client");
const { auditLog, events, jobEvidence, jobs, repoSettings, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema, ingestBodySchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts, localHost } = await import("../lib/host");
const { github } = await import("../lib/github/pulls");
const { evidenceLine, headEvidence, outputTail, parseSummary, planChecks } = await import("../lib/evidence");
const { writeRepoAutonomy } = await import("../lib/settings");
const { decideMerges, requiredChecks } = await import("../runner/merge-decision");
const { forgetVerifications, runnerVerification, startVerification, verificationsSettled, verifyAtHead, verifyingKeys, verifyRuntime } = await import("../runner/verify");
const { DEFAULT_POLICY } = await import("../lib/merge-decision");
const { ingestClient } = await import("../runner/ops");
const { serve } = await import("./serve");

const stamp = Date.now() % 1_000_000;
const dir = mkdtempSync(join(tmpdir(), "evidence-regress-"));
const keys: string[] = [];
const REPO = `regress/evidence-${stamp}`;
const TRIAL_REPO = `regress/evidence-trial-${stamp}`;
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const evidenceRows = async (k: string) => db.select().from(jobEvidence).where(eq(jobEvidence.job_key, k));
async function insert(name: string, over: Partial<typeof jobs.$inferInsert> = {}) {
  const k = `EV${name}-${stamp}`;
  keys.push(k);
  await db.insert(jobs).values(linearJob(`evidence-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, repo: REPO, provider: "claudeAgent", ...over }));
  await db.insert(runs).values(usageRun(k));
  return k;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const check = (name: EvidenceCheck["name"], passed: boolean, over: Partial<EvidenceCheck> = {}): EvidenceCheck => ({
  name,
  command: `bun run ${name}`,
  exitCode: passed ? 0 : 1,
  startedAt: new Date().toISOString(),
  durationMs: 1500,
  outputTail: passed ? "ok" : "1 failing",
  passed,
  ...over,
});
const evidence = (k: string, sha: string, at: number, over: Record<string, unknown> = {}) =>
  eventSchema.parse({
    eventId: `evidence-regress-${k}-${sha}-${at}`,
    sessionId: `evidence:factory/${k}`,
    at,
    kind: "evidence",
    jobKey: k,
    attempt: 1,
    repo: REPO,
    sha,
    clean: true,
    producer: "agent",
    source: "package",
    checks: [check("test", true), check("lint", true)],
    ...over,
  });

// --- what to run
const recipe = { setup: ["bun install"], checks: { test: "bun test", build: "bun run build" }, env: [{ name: "STRIPE_KEY", purpose: "tests", required: true }] };
assert.deepEqual(
  planChecks({ recipe, packageJson: null, files: [] }),
  { source: "recipe", setup: ["bun install"], checks: [{ name: "test", command: "bun test" }, { name: "build", command: "bun run build" }], envNames: ["STRIPE_KEY"] },
  "the recipe's checks, in check order",
);
assert.deepEqual(
  planChecks({ recipe: null, packageJson: JSON.stringify({ scripts: { lint: "eslint", test: "vitest", dev: "next dev" } }), files: ["bun.lock"] }),
  { source: "package", setup: ["bun install --frozen-lockfile"], checks: [{ name: "test", command: "bun run test" }, { name: "lint", command: "bun run lint" }], envNames: [] },
  "without a recipe, package.json scripts by the lockfile's package manager",
);
assert.equal(planChecks({ recipe: null, packageJson: JSON.stringify({ scripts: { test: "jest" } }), files: [] }).checks[0]!.command, "npm run test", "npm without a lockfile");
assert.deepEqual(planChecks({ recipe: null, packageJson: "{not json", files: [] }).source, "none", "a broken package.json defines nothing");
assert.deepEqual(planChecks({ recipe: null, packageJson: null, files: [] }).checks, [], "no recipe, no package.json: no checks");

// --- redaction
const secretValue = "s3cr3t-value-0123456789";
const tail = outputTail(
  [
    `connecting with STRIPE_KEY=sk_live_abc123456789`,
    `token ghp_abcdefghijklmnopqrstuvwxyz0123`,
    `Authorization: Bearer abcdefghijklmnop`,
    `https://user:hunter2hunter2@example.com/repo.git`,
    `the value is ${secretValue} here`,
    ...Array.from({ length: 60 }, (_, i) => `line ${i}`),
  ]
    .reverse()
    .join("\n"),
  { envNames: ["STRIPE_KEY"], secrets: [secretValue] },
);
for (const leaked of ["sk_live_abc123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123", "abcdefghijklmnop", "hunter2hunter2", secretValue]) {
  assert.ok(!tail.includes(leaked), `the tail keeps no ${leaked.slice(0, 6)}…: ${tail}`);
}
assert.ok(tail.split("\n").length <= 40 && tail.length <= 4000, "capped to 40 lines and 4000 characters");
assert.ok(outputTail("x".repeat(100_000)).length <= 4000, "a single long line is capped too");

// --- what evidence proves about a head
const at = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000);
const ev = (sha: string, over: Partial<Parameters<typeof headEvidence>[0][number]> = {}) => ({
  sha,
  clean: true,
  producer: "agent" as const,
  source: "package" as const,
  checks: [check("test", true), check("lint", true)],
  recordedAt: at(0),
  ...over,
});
assert.deepEqual(headEvidence([ev(SHA_A)], SHA_A, null), { state: "verified", sha: SHA_A, passed: 2, total: 2, producer: "agent" });
assert.deepEqual(headEvidence([], SHA_A, null), { state: "missing" });
assert.deepEqual(headEvidence([ev(SHA_B), ev("c".repeat(40), { recordedAt: at(5) })], SHA_A, null), { state: "stale", sha: "c".repeat(40) }, "stale names the newest commit with evidence");
assert.deepEqual(headEvidence([ev(SHA_A, { clean: false })], SHA_A, null), { state: "dirty", sha: SHA_A });
assert.deepEqual(headEvidence([ev(SHA_A, { checks: [check("test", true), check("lint", false)] })], SHA_A, null), { state: "failed", sha: SHA_A, failed: ["lint"], passed: 1, total: 2 });
assert.deepEqual(headEvidence([ev(SHA_A)], SHA_A, ["test", "lint", "build"]), { state: "incomplete", sha: SHA_A, missing: ["build"] }, "the recipe's checks are required");
assert.deepEqual(headEvidence([ev(SHA_A)], SHA_A, []), { state: "no_checks" }, "a recipe with no checks");
assert.deepEqual(headEvidence([ev(SHA_A, { source: "none", checks: [] })], SHA_A, null), { state: "no_checks" }, "evidence that found no checks");
assert.deepEqual(
  headEvidence([ev(SHA_A, { checks: [check("custom", false), check("test", false)] })], SHA_A, null),
  { state: "failed", sha: SHA_A, failed: ["setup", "test"], passed: 0, total: 2 },
  "a failed setup is named setup",
);
const rows = [{ repo: REPO, onboarding_detail: { recipe } }] as unknown as Parameters<typeof requiredChecks>[0];
assert.deepEqual(requiredChecks(rows, REPO).required, ["test", "build"], "required comes from the recorded recipe");
assert.equal(requiredChecks(rows, "other/repo").required, null, "no recipe, no required list");

const summary = (over: Record<string, unknown> = {}) => parseSummary({ sha: SHA_A, attempt: 1, clean: true, producer: "agent", source: "package", at: at(0).toISOString(), checks: [{ name: "test", passed: true, exitCode: 0, durationMs: 1 }, { name: "lint", passed: true, exitCode: 0, durationMs: 1 }], ...over });
assert.deepEqual(evidenceLine(summary(), SHA_A, { expected: true }), { text: "Verified at aaaaaaa · 2/2 checks", tone: "success" });
assert.deepEqual(evidenceLine(summary(), SHA_B, { expected: true }), { text: "Not verified at head", tone: "warning" }, "evidence for another commit");
assert.deepEqual(evidenceLine(null, null, { expected: true }), { text: "Not verified at head", tone: "warning" });
assert.equal(evidenceLine(null, null, { expected: false }), null, "nothing to say before pr");
assert.equal(evidenceLine(summary({ clean: false }), SHA_A, { expected: true })!.text, "Not verified at aaaaaaa · uncommitted changes");
assert.equal(evidenceLine(summary({ checks: [{ name: "test", passed: false, exitCode: 1, durationMs: 1 }] }), null, { expected: true })!.text, "Checks failed at aaaaaaa · 0/1 check");

// --- the CLI against a temp git repo, posting through the outbox to a stand-in ingest
const SECRET = "evidence-ingest-secret";
const received: FactoryEvent[][] = [];
const server = await serve(0, async (request) => {
  if (request.headers.get("authorization") !== `Bearer ${SECRET}`) return Response.json({ error: "unauthorized" }, { status: 401 });
  const parsed = ingestBodySchema.safeParse(await request.json());
  if (!parsed.success) return Response.json({ error: "invalid body" }, { status: 400 });
  received.push(parsed.data);
  return Response.json(await ingest(db, parsed.data));
});
const configPath = join(dir, "config.json");
writeFileSync(configPath, JSON.stringify({ ingestUrl: `http://localhost:${server.port}/ingest`, secret: SECRET }));
const verifyScript = join(import.meta.dirname, "../hooks/verify.ts");
const childEnv = (over: Record<string, string> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: dir, MARSHAL_FACTORY_CONFIG: configPath, FACTORY_STATE_DIR: join(dir, "state"), ...over };
  for (const name of ["FACTORY_JOB_KEY", "FACTORY_ATTEMPT", "FACTORY_SESSION_ID", "GITHUB_TOKEN"]) if (!(name in over)) delete env[name];
  return env as NodeJS.ProcessEnv;
};
const runVerify = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bun", [verifyScript, ...args], { cwd, env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" }).trim();

function repoWith(branch: string, scripts: Record<string, string>, extra: Record<string, string> = {}) {
  const repo = mkdtempSync(join(dir, "repo-"));
  execFileSync("git", ["init", "-q", "-b", branch, repo]);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo", scripts }));
  for (const [path, text] of Object.entries(extra)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "init");
  gitIn(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
  return repo;
}

const SECRET_TOKEN = "ghp_cliSecretToken0123456789abcdef";

try {
  // Ingest: latest per commit, a dirty run never replaces a clean one, the job keeps a summary.
  const INGEST = await insert("INGEST", { stage: "verifying" });
  await ingest(db, [evidence(INGEST, SHA_A, 1000, { checks: [check("test", false)] })]);
  await ingest(db, [evidence(INGEST, SHA_A, 3000)]);
  await ingest(db, [evidence(INGEST, SHA_A, 2000, { checks: [check("test", false)] })]);
  let stored = await evidenceRows(INGEST);
  assert.equal(stored.length, 1, "one row per job and commit");
  assert.deepEqual([stored[0]!.recorded_at.getTime(), stored[0]!.checks.map((c) => c.passed)], [3000, [true, true]], "the latest run wins; a late older one is ignored");
  await ingest(db, [evidence(INGEST, SHA_A, 4000, { clean: false, checks: [check("test", false)] })]);
  stored = await evidenceRows(INGEST);
  assert.deepEqual([stored[0]!.clean, stored[0]!.recorded_at.getTime()], [true, 3000], "a dirty run doesn't replace clean evidence for the same commit");
  await ingest(db, [evidence(INGEST, SHA_B, 5000, { clean: false })]);
  assert.equal((await evidenceRows(INGEST)).find((r) => r.sha === SHA_B)!.clean, false, "dirty evidence is kept for its commit, marked dirty");
  const job = await row(INGEST);
  assert.deepEqual(
    [job.evidence?.sha, job.evidence?.clean, job.evidence?.checks.length, job.stage],
    [SHA_B, false, 2, "verifying"],
    "the job's summary follows its newest evidence; the stage is the agent's and stays",
  );
  assert.equal((await db.select().from(runs).where(eq(runs.session_id, `evidence:factory/${INGEST}`))).length, 0, "evidence opens no run");
  const [event] = await db.select().from(events).where(eq(events.event_id, `evidence-regress-${INGEST}-${SHA_A}-1000`));
  assert.equal(event!.job_key, INGEST, "the event is kept under the job");
  await ingest(db, [evidence(INGEST, "c".repeat(40), 6000, { attempt: 2 })]);
  assert.equal((await row(INGEST)).evidence?.sha, SHA_B, "another attempt's evidence leaves the job's summary");
  assert.ok(!eventSchema.safeParse({ ...evidence(INGEST, SHA_A, 1), sha: "abc" }).success, "a sha must be a full commit id");
  assert.ok(!eventSchema.safeParse({ ...evidence(INGEST, SHA_A, 1), checks: [check("test", true, { outputTail: "x".repeat(4001) })] }).success, "an output tail over the cap is refused");

  // The CLI: passing, failing and dirty runs, each at the exact HEAD, posted through the outbox.
  const CLI = await insert("CLI", { stage: "verifying" });
  const passing = repoWith(`factory/${CLI}`, { test: "echo all good", lint: "true" });
  const passed = await runVerify(passing, ["--json"]);
  assert.equal(passed.code, 0, passed.stderr);
  const posted = eventSchema.parse(JSON.parse(passed.stdout));
  assert.ok(posted.kind === "evidence");
  assert.deepEqual(
    [posted.sha, posted.clean, posted.jobKey, posted.attempt, posted.repo, posted.source, posted.producer, posted.checks.map((c) => [c.name, c.exitCode, c.passed])],
    [gitIn(passing, "rev-parse", "HEAD"), true, CLI, 1, "acme/demo", "package", "agent", [["test", 0, true], ["lint", 0, true]]],
  );
  assert.match(posted.checks[0]!.outputTail, /all good/);
  assert.match(passed.stderr, /verified at [0-9a-f]{7} · 2\/2 checks/);
  assert.match(passed.stderr, new RegExp(`reported for ${CLI}`));
  assert.equal(received.at(-1)![0]!.eventId, posted.eventId, "posted to ingest through the outbox");
  assert.deepEqual((await evidenceRows(CLI)).map((r) => [r.sha, r.clean]), [[posted.sha, true]], "and stored for that commit");

  const failing = repoWith(`factory/${CLI}`, { test: `echo "token $GITHUB_TOKEN"; echo boom >&2; exit 3`, lint: "true" });
  const failed = await runVerify(failing, ["--json", "--no-post"], { GITHUB_TOKEN: SECRET_TOKEN });
  assert.equal(failed.code, 1, "a failing check exits 1");
  const failedEvent = eventSchema.parse(JSON.parse(failed.stdout));
  assert.ok(failedEvent.kind === "evidence");
  assert.deepEqual(failedEvent.checks.map((c) => [c.name, c.exitCode, c.passed]), [["test", 3, false], ["lint", 0, true]], "every check runs, even after a failure");
  assert.match(failedEvent.checks[0]!.outputTail, /boom/, "stderr is in the tail");
  assert.ok(!failedEvent.checks[0]!.outputTail.includes(SECRET_TOKEN) && !failed.stderr.includes(SECRET_TOKEN), "a token in the output is redacted");
  assert.equal(received.flat().filter((e) => e.eventId === failedEvent.eventId).length, 0, "--no-post posts nothing");

  writeFileSync(join(passing, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "echo changed", lint: "true" } }));
  const dirty = await runVerify(passing, ["--json", "--no-post"]);
  assert.equal(dirty.code, 1, "a dirty tree never verifies");
  const dirtyEvent = eventSchema.parse(JSON.parse(dirty.stdout));
  assert.ok(dirtyEvent.kind === "evidence" && !dirtyEvent.clean && dirtyEvent.checks.every((c) => c.passed), "the checks pass, but the evidence is dirty");
  assert.match(dirty.stderr, /uncommitted changes/);

  const recipeRepo = repoWith(`factory/${CLI}-a2`, { test: "exit 1" }, { ".factory/setup.json": JSON.stringify({ setup: [], checks: { test: "true", typecheck: "true" } }) });
  const fromRecipe = eventSchema.parse(JSON.parse((await runVerify(recipeRepo, ["--json", "--no-post"])).stdout));
  assert.ok(fromRecipe.kind === "evidence");
  assert.deepEqual([fromRecipe.source, fromRecipe.attempt, fromRecipe.checks.map((c) => c.name)], ["recipe", 2, ["test", "typecheck"]], "the recipe wins over package.json; the attempt comes from the branch");

  const offBranch = repoWith("main", { test: "true" });
  const off = await runVerify(offBranch, []);
  assert.equal(off.code, 0);
  assert.match(off.stderr, /on no factory branch, so nothing was reported/);
  assert.equal((await runVerify(dir, ["--no-post"])).code, 2, "outside a git repo");

  // The runner's own verification, in a fake sandbox that is this machine with temp dirs.
  await writeRepoAutonomy(db, { repo: REPO, autonomy: "auto" }, "owner@example.com", new Date());
  await writeRepoAutonomy(db, { repo: TRIAL_REPO, autonomy: "trial" }, "owner@example.com", new Date());
  const origin = join(dir, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", origin]);
  const work = repoWith("main", { test: "true" });
  gitIn(work, "remote", "set-url", "origin", origin);
  gitIn(work, "push", "-q", "origin", "main");
  const pushBranch = (branch: string, scripts: Record<string, string>) => {
    gitIn(work, "checkout", "-q", "-B", branch, "main");
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "demo", scripts }));
    mkdirSync(join(work, ".factory"), { recursive: true });
    writeFileSync(join(work, ".factory/setup.json"), JSON.stringify({ setup: ["echo set up"], checks: { test: scripts.test ?? "true", lint: scripts.lint ?? "true" } }));
    gitIn(work, "add", "-A");
    gitIn(work, "commit", "-q", "-m", branch);
    gitIn(work, "push", "-q", "-f", "origin", branch);
    return gitIn(work, "rev-parse", "HEAD");
  };
  const sandboxRepo = join(dir, "sandbox-repo");
  execFileSync("git", ["clone", "-q", origin, sandboxRepo]);
  verifyRuntime.repoDir = sandboxRepo;
  verifyRuntime.workDir = join(dir, "verify");

  const RUNNER = await insert("RUNNER");
  const ASLEEP = await insert("ASLEEP");
  const BROKEN = await insert("BROKEN");
  const GONE = await insert("GONE");
  const LOCAL = await insert("LOCAL");
  const TRIAL = await insert("TRIAL", { repo: TRIAL_REPO });
  const heads = new Map<string, string>([
    [RUNNER, pushBranch(`factory/${RUNNER}`, { test: "echo runner ran", lint: "true" })],
    [ASLEEP, pushBranch(`factory/${ASLEEP}`, { test: "true", lint: "exit 4" })],
    [BROKEN, (pushBranch(`factory/${BROKEN}`, { test: "true" }), "d".repeat(40))],
    [GONE, "e".repeat(40)],
    [LOCAL, "f".repeat(40)],
    [TRIAL, "1".repeat(40)],
  ]);
  const assessment: MergeAssessment = {
    recommendation: "merge",
    interpretation: "x",
    assumptions: [],
    confidence: { confident: true },
  };
  const byUrl = new Map<string, string>();
  const pr = (k: string, over: Partial<typeof jobs.$inferInsert>) => {
    const url = over.pr_url ?? `https://github.com/${REPO}/pull/${keys.indexOf(k) + 1}`;
    byUrl.set(url, k);
    return db.update(jobs).set({ stage: "pr", stage_event_id: `evidence-regress-pr-${k}`, merge_assessment: assessment, execution: "modal", ...over, pr_url: url }).where(eq(jobs.key, k));
  };
  await pr(RUNNER, { sandbox_id: "sb-evidence-runner" });
  await pr(ASLEEP, { sandbox_snapshot: "im-evidence-asleep" });
  await pr(BROKEN, { sandbox_id: "sb-evidence-broken" });
  await pr(GONE, { sandbox_id: "sb-evidence-gone" });
  await pr(LOCAL, { execution: "local" });
  await pr(TRIAL, { sandbox_id: "sb-evidence-trial", pr_url: `https://github.com/${TRIAL_REPO}/pull/1` });
  github.pullDetail = async (url) => ({ state: "open", mergeable: "mergeable", headSha: heads.get(byUrl.get(url)!)!, baseRef: "main" });
  github.pullFiles = async () => [{ path: "src/a.ts", additions: 1, deletions: 1 }];
  github.checkState = async () => ({ checks: "success", bugbot: { state: "reviewed" } });
  github.bugbotFindings = async () => [];
  github.upsertComment = async () => "created";
  github.mergeCandidate = async () => ({ state: "open", headSha: "moved", baseRef: "main", title: "t", number: 1, commits: 1, mergeCommitSha: null, mergedByBot: false });
  SOURCES.linear.labels = async () => ["factory"];
  SOURCES.linear.note = async () => undefined;
  ingestClient.post = async (e) => ingest(db, [eventSchema.parse(e)]);
  const woke: string[] = [];
  hosts.wake = async (j) => (woke.push(j.key), localHost);

  // The cap: two runs at a time, held open here until released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  hosts.sandbox = () => ({ ...localHost, run: async () => gate.then(() => Promise.reject(new Error("released"))) });
  const capJob = (k: string) => ({ key: k, sandbox_id: "sb-cap", sandbox_snapshot: null, attempt: 1, repo: REPO, execution: "modal" });
  const noPost = async () => undefined;
  assert.deepEqual(
    [startVerification(capJob("CAP-1"), SHA_A, null, noPost), startVerification(capJob("CAP-2"), SHA_A, null, noPost), startVerification(capJob("CAP-3"), SHA_A, null, noPost)],
    [true, true, false],
    "a third run waits for a free slot",
  );
  assert.deepEqual([...verifyingKeys()].sort(), ["CAP-1", "CAP-2"], "and hibernation leaves the busy sandboxes alone");
  // A head that moves while its sandbox is verifying the old one waits for that run to end.
  const autoPolicy = { ...DEFAULT_POLICY, autonomy: "auto" as const };
  assert.deepEqual(runnerVerification(capJob("CAP-1"), SHA_B, autoPolicy, null, Date.now()), { kind: "running" }, "the new head waits for the old head's run");
  assert.equal(startVerification(capJob("CAP-1"), SHA_B, null, noPost), false, "and no second run starts on the same sandbox");
  release();
  await verificationsSettled();
  assert.deepEqual([...verifyingKeys()], [], "the old run ended");
  assert.deepEqual(runnerVerification(capJob("CAP-1"), SHA_B, autoPolicy, null, Date.now()), { kind: "available" }, "then the new head is the runner's to verify");
  forgetVerifications();

  // Two runs at the same commit each check out their own worktree; one ending leaves the other's alone.
  const slowRecipe = { setup: [], checks: { test: "sleep 1 && test -f package.json" } };
  const overlapping = await Promise.all([0, 300].map(async (delay) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return verifyAtHead(localHost, { key: RUNNER, attempt: 1, repo: REPO }, heads.get(RUNNER)!, slowRecipe);
  }));
  assert.deepEqual(
    overlapping.map((e) => (e.kind === "evidence" ? e.checks.map((c) => c.passed) : null)),
    [[true], [true]],
    "overlapping runs at one commit don't share a worktree",
  );

  hosts.sandbox = (id) => {
    if (id === "sb-evidence-gone") return { ...localHost, run: async () => Promise.reject(Object.assign(new Error("gone"), { code: 128 })) };
    return localHost;
  };
  const only = { only: [RUNNER, ASLEEP, BROKEN, GONE, LOCAL, TRIAL] };
  const decisionOf = async (k: string) => (await row(k)).merge_decision!;
  const first = await decideMerges({ ...only, now: Date.now() });
  assert.ok(Array.isArray(first), JSON.stringify(first));
  for (const k of [RUNNER, ASLEEP, BROKEN, GONE]) {
    const d = await decisionOf(k);
    assert.deepEqual([d.outcome, d.reasons, d.evidence], ["pending", [`Waiting for verification at ${heads.get(k)!.slice(0, 7)}.`], { state: "missing" }], `${k} waits for the runner`);
    // Runs that finish fast free their slot within the pass; the rest start on a later one.
    if (d.verification) assert.deepEqual([d.verification.state, d.verification.sha], ["running", heads.get(k)]);
  }
  assert.match((await decisionOf(LOCAL)).reasons.join(" "), /Not verified at fffffff: no checks were reported for it; the run isn't in a cloud sandbox/, "a local job can't be verified by the runner");
  assert.match((await decisionOf(TRIAL)).reasons.join(" "), /only when the repo merges on its own/, "trial never runs the checks itself");
  assert.equal((await decisionOf(TRIAL)).verification, undefined);

  // More passes until every head was verified, or tried.
  for (let pass = 0; pass < 3; pass++) {
    await verificationsSettled();
    await decideMerges({ ...only, now: Date.now() });
  }
  await verificationsSettled();
  assert.deepEqual(woke, [ASLEEP], "a hibernated sandbox is woken for the run");
  const runnerRows = await evidenceRows(RUNNER);
  assert.deepEqual(
    runnerRows.map((r) => [r.sha, r.producer, r.clean, r.source, r.checks.map((c) => [c.name, c.passed])]),
    [[heads.get(RUNNER), "runner", true, "recipe", [["custom", true], ["test", true], ["lint", true]]]],
    "the runner ran setup and the checks at exactly the head",
  );
  assert.match(runnerRows[0]!.checks[1]!.outputTail, /runner ran/);

  const second = await decideMerges({ ...only, now: Date.now() });
  assert.ok(Array.isArray(second), JSON.stringify(second));
  const verified = await decisionOf(RUNNER);
  assert.deepEqual([verified.outcome, verified.evidence], ["merge", { state: "verified", sha: heads.get(RUNNER), passed: 3, total: 3, producer: "runner" }], "with the runner's evidence it merges");
  assert.deepEqual((await decisionOf(ASLEEP)).reasons, [`Checks failed at ${heads.get(ASLEEP)!.slice(0, 7)}: lint.`], "the runner's failing evidence hands over");
  assert.match((await decisionOf(BROKEN)).reasons.join(" "), /couldn't run the checks itself: commit ddddddd isn't on factory\//, "a head the branch doesn't have");
  assert.match((await decisionOf(GONE)).reasons.join(" "), /couldn't run the checks itself/, "a sandbox that can't run anything");
  assert.equal((await decisionOf(BROKEN)).verification?.state, "failed", "the failure is kept, so it is not retried for this head");
  forgetVerifications();
  await decideMerges({ only: [BROKEN], now: Date.now() + 60 * 60_000 });
  assert.equal((await decisionOf(BROKEN)).outcome, "handover", "after a restart the failed head still hands over, with no new run");
  await verificationsSettled();
  assert.equal(woke.length, 1);

  // A new head moves the decision back to the runner, once.
  heads.set(RUNNER, pushBranch(`factory/${RUNNER}`, { test: "true", lint: "true" }));
  await decideMerges({ only: [RUNNER], now: Date.now() });
  assert.deepEqual([(await decisionOf(RUNNER)).outcome, (await decisionOf(RUNNER)).evidence?.state], ["pending", "stale"], "evidence for the old head is stale");
  await verificationsSettled();
  await decideMerges({ only: [RUNNER], now: Date.now() });
  assert.equal((await decisionOf(RUNNER)).outcome, "merge");
  assert.equal((await evidenceRows(RUNNER)).length, 2, "one row per head");

  console.log("evidence regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await server.close();
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(like(jobs.id, `${jobId("linear", "evidence-regress-")}%`))).map((j) => j.id);
  if (ids.length > 0) await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
  if (keys.length > 0) {
    await db.delete(events).where(inArray(events.job_key, keys));
    await db.delete(jobEvidence).where(inArray(jobEvidence.job_key, keys));
    await db.delete(runs).where(inArray(runs.job_key, keys));
  }
  await db.delete(runs).where(and(like(runs.session_id, "evidence:%")));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "evidence-regress-")}%`));
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [REPO, TRIAL_REPO]));
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
