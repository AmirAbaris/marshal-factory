import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import type { MergeAssessment } from "../lib/assessment";
import type { DecisionInput, PrFacts } from "../lib/merge-decision";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { auditLog, events, jobEvidence, jobs, repoSettings, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema, stageReportSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts } = await import("../lib/host");
const { github, bugbotFindingsOf, checkStateOf, pullsClient } = await import("../lib/github/pulls");
const { COST_UNKNOWN_REASON, decideMerge, DEFAULT_POLICY, globToRegExp, majorBumps, matchesAny } = await import("../lib/merge-decision");
const { readRepoSettings, resolvePolicy, writeRepoAutonomy } = await import("../lib/settings");
const { decideMerges, RECHECK_MS } = await import("../runner/merge-decision");
const { serve } = await import("./serve");

const ok = (note = "fine") => ({ ok: true, note });
const assessment = (over: Partial<MergeAssessment> = {}): MergeAssessment => ({
  recommendation: "merge",
  interpretation: "Sort the list by name.",
  assumptions: ["Case-insensitive, like the search box."],
  checks: { interpretation: ok(), proven: ok(), contained: ok(), reversible: ok(), noTasteCalls: ok(), noSurprises: ok() },
  ...over,
});

// --- report_stage schema
const prReport = { stage: "pr", summary: "Opened", prUrl: "https://github.com/o/r/pull/1" };
assert.ok(stageReportSchema.safeParse({ ...prReport, assessment: assessment() }).success, "pr takes an assessment");
assert.ok(stageReportSchema.safeParse(prReport).success, "the assessment is optional");
const reject = (input: unknown, why: string) => assert.ok(!stageReportSchema.safeParse(input).success, why);
reject({ stage: "verifying", summary: "x", assessment: assessment() }, "only pr takes an assessment");
reject({ ...prReport, assessment: assessment({ checks: { ...assessment().checks, proven: { ok: false, note: "no test" } } }) }, "merge needs all six checks ok");
reject({ ...prReport, assessment: { ...assessment(), recommendation: "ship" } }, "an unknown recommendation");
reject({ ...prReport, assessment: { ...assessment(), checks: { ...assessment().checks, noSurprises: undefined } } }, "a missing check");
reject({ ...prReport, assessment: assessment({ interpretation: "x".repeat(2001) }) }, "an interpretation over the size limit");
reject({ ...prReport, assessment: assessment({ assumptions: Array.from({ length: 13 }, () => "a") }) }, "too many assumptions");
reject({ ...prReport, assessment: assessment({ checks: { ...assessment().checks, contained: { ok: true, note: "" } } }) }, "an empty note");
assert.ok(
  stageReportSchema.safeParse({ ...prReport, assessment: assessment({ recommendation: "handover", checks: { ...assessment().checks, noTasteCalls: { ok: false, note: "Copy" } }, reviewFocus: "The copy" }) }).success,
  "handover with a failed check and a review focus",
);

// --- globs and manifests
assert.ok(globToRegExp("**/migrations/**").test("db/migrations/001.sql") && globToRegExp("**/migrations/**").test("migrations/1.sql"), "** spans zero or more dirs");
assert.ok(!globToRegExp("vercel.json").test("apps/vercel.json"), "a plain name matches at the root only");
assert.ok(matchesAny(".env.local", DEFAULT_POLICY.protectedPaths) && matchesAny("apps/web/.env", DEFAULT_POLICY.protectedPaths));
assert.ok(matchesAny(".github/workflows/ci.yml", DEFAULT_POLICY.protectedPaths) && !matchesAny("src/app/page.tsx", DEFAULT_POLICY.protectedPaths));
assert.ok(!globToRegExp("*.ts").test("a/b.ts") && globToRegExp("*.ts").test("b.ts"), "* stays inside one dir");
const manifest = (patch: string) => [{ path: "package.json", additions: 1, deletions: 1, patch }];
assert.deepEqual(majorBumps(manifest(`-    "next": "^15.1.0",\n+    "next": "^16.0.0",\n-    "zod": "^4.1.0"\n+    "zod": "^4.2.0"`)), ["next"], "a major bump, a minor one is fine");
assert.deepEqual(majorBumps(manifest(`+    "left-pad": "^1.0.0",`)), [], "a new dependency is no bump");
assert.deepEqual(majorBumps([{ path: "README.md", additions: 1, deletions: 1, patch: `-  "a": "1.0.0"\n+  "a": "2.0.0"` }]), [], "only manifests count");

// --- decideMerge
const NOW = 1_800_000_000_000;
const facts = (over: Partial<PrFacts> = {}): PrFacts => ({
  headSha: "h1",
  mergeable: "mergeable",
  behindBy: 0,
  checks: "success",
  bugbot: { review: { state: "reviewed" }, findings: [] },
  files: [{ path: "src/list.tsx", additions: 10, deletions: 2 }],
  ...over,
});
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  policy: { ...DEFAULT_POLICY, autonomy: "trial" },
  costKnown: true,
  assessment: assessment(),
  attempt: 1,
  spendUsd: 1,
  budgetUsd: 5,
  labels: ["factory"],
  pr: facts(),
  headSeenAt: NOW - 60_000,
  now: NOW,
  evidence: { state: "verified", sha: "h1", passed: 4, total: 4, producer: "agent" },
  runner: { kind: "unavailable", reason: "the run isn't in a Modal sandbox, so the factory can't run them itself" },
  ...over,
});
const handsOver = (over: Partial<DecisionInput>, pattern: RegExp, why: string) => {
  const decision = decideMerge(input(over));
  assert.equal(decision.outcome, "handover", `${why}: ${JSON.stringify(decision)}`);
  assert.ok(decision.reasons.some((r) => pattern.test(r)), `${why}: ${JSON.stringify(decision.reasons)}`);
};

assert.deepEqual(decideMerge(input()), { outcome: "merge", reasons: [] }, "trial: everything holds, so it would merge");
assert.deepEqual(decideMerge(input({ policy: { ...DEFAULT_POLICY, autonomy: "auto" } })), { outcome: "merge", reasons: [] }, "auto merges with no caveat");
assert.deepEqual(decideMerge(input({ policy: DEFAULT_POLICY, pr: null, costKnown: false, attempt: 3 })), { outcome: "handover", reasons: [] }, "off evaluates nothing");
assert.throws(() => decideMerge(input({ pr: null })), /needs the PR's facts/);
handsOver({ costKnown: false, assessment: null }, /^This run's cost is unknown, so it can't be held to its budget\.$/, "a run whose cost is unknown");
assert.deepEqual(decideMerge(input({ costKnown: false })).reasons, [COST_UNKNOWN_REASON], "a merge assessment doesn't stand in for a known cost");
handsOver({ assessment: null }, /didn't report a merge assessment/, "a run with a known cost and no assessment");
handsOver({ assessment: assessment({ recommendation: "handover", checks: { ...assessment().checks, noTasteCalls: { ok: false, note: "The empty-state copy is a product call." } } }) }, /^No taste or product calls: The empty-state copy/, "the agent hands over, naming the check");
handsOver({ assessment: assessment({ recommendation: "handover" }) }, /recommends handing over/, "a handover with every check ok");
handsOver({ labels: ["factory", "Review"] }, /"review" label/, "the review label forces a handover");
handsOver({ attempt: 2 }, /attempt 2/, "a retry");
handsOver({ spendUsd: 5 }, /over its budget/, "over budget");
handsOver({ pr: facts({ checks: "failure" }) }, /check failed/, "a failed check");
handsOver({ pr: facts({ mergeable: "conflicting" }) }, /conflicts/, "a conflict");
handsOver({ pr: facts({ behindBy: 2 }) }, /2 commits behind/, "behind its base");
handsOver({ pr: facts({ bugbot: { review: { state: "reviewed" }, findings: [{ severity: "medium", resolved: false }] } }) }, /1 unresolved medium or high finding/, "an open Bugbot finding");
assert.equal(decideMerge(input({ pr: facts({ bugbot: { review: { state: "reviewed" }, findings: [{ severity: "high", resolved: true }, { severity: "low", resolved: false }] } }) })).outcome, "merge", "resolved and low findings pass");
handsOver({ pr: facts({ files: [{ path: "drizzle/0001.sql", additions: 1, deletions: 0 }] }) }, /protected paths: drizzle\/0001\.sql/, "a migration");
handsOver({ pr: facts({ files: [{ path: "lib/session.ts", previousPath: "lib/auth/session.ts", additions: 1, deletions: 1 }] }) }, /lib\/auth\/session\.ts/, "a rename out of a protected path");
handsOver({ pr: facts({ files: manifest(`-    "next": "^15.0.0",\n+    "next": "^16.0.0",`) }) }, /major version of next/, "a major dependency bump");
handsOver({ pr: facts({ files: [{ path: "a.ts", additions: 200, deletions: 101 }] }) }, /301 lines, over the limit of 300/, "too big");
assert.equal(decideMerge(input({ pr: facts({ files: [{ path: "a.ts", additions: 200, deletions: 100 }] }) })).outcome, "merge", "the limit itself is fine");
const ownPolicy = { policy: { autonomy: "trial" as const, protectedPaths: ["src/**"], maxChangedLines: 5 } };
handsOver(ownPolicy, /protected paths: src\/list\.tsx/, "the repo's own globs apply");
handsOver(ownPolicy, /over the limit of 5/, "and its own size limit");

const pending = decideMerge(input({ pr: facts({ checks: "pending", bugbot: { review: { state: "pending" }, findings: [] } }) }));
assert.deepEqual(pending, { outcome: "pending", reasons: ["Waiting for checks, Bugbot."] }, "running checks are pending, not a handover");
assert.equal(decideMerge(input({ pr: facts({ mergeable: "unknown" }) })).outcome, "pending", "so is GitHub computing mergeability");
handsOver({ pr: facts({ checks: "pending" }), headSeenAt: NOW - 61 * 60_000 }, /^Checks didn't finish within 60 minutes\.$/, "pending past the timeout");
handsOver({ pr: facts({ checks: "pending" }), attempt: 2 }, /attempt 2/, "a hard failure does not wait for checks");

// --- verified at head
const auto = { policy: { ...DEFAULT_POLICY, autonomy: "auto" as const } };
handsOver({ evidence: { state: "no_checks" } }, /^No checks defined for this repo\.$/, "a repo with no checks never merges on its own");
handsOver({ evidence: { state: "failed", sha: "h1", failed: ["test", "build"], passed: 2, total: 4 } }, /^Checks failed at h1: test, build\.$/, "a failed check at the head");
handsOver({ evidence: { state: "missing" } }, /^Not verified at h1: no checks were reported for it; the run isn't in a Modal sandbox/, "no evidence and nobody to verify");
handsOver({ evidence: { state: "stale", sha: "h0" } }, /^Not verified at h1: the latest checks ran at h0;/, "evidence for an older commit");
handsOver({ evidence: { state: "dirty", sha: "h1" } }, /uncommitted changes/, "a dirty tree proves nothing");
handsOver({ evidence: { state: "incomplete", sha: "h1", missing: ["build"] } }, /didn't include build/, "a required check that didn't run");
assert.deepEqual(
  decideMerge(input({ ...auto, evidence: { state: "stale", sha: "h0" }, runner: { kind: "available" } })),
  { outcome: "pending", reasons: ["Waiting for verification at h1."], verify: true },
  "stale evidence under auto waits for the runner, which may start",
);
assert.deepEqual(
  decideMerge(input({ ...auto, evidence: { state: "missing" }, runner: { kind: "running" } })),
  { outcome: "pending", reasons: ["Waiting for verification at h1."] },
  "a running verification is waited for, not started again",
);
assert.deepEqual(
  decideMerge(input({ ...auto, evidence: { state: "missing" }, runner: { kind: "available" }, pr: facts({ checks: "pending" }) })),
  { outcome: "pending", reasons: ["Waiting for checks, verification at h1."] },
  "the runner waits until verification is all that is left",
);
handsOver({ ...auto, evidence: { state: "missing" }, runner: { kind: "failed", reason: "the job's sandbox is gone" } }, /couldn't run the checks itself: the job's sandbox is gone\.$/, "a runner verification that couldn't run");
handsOver({ ...auto, evidence: { state: "missing" }, runner: { kind: "available" }, headSeenAt: NOW - 61 * 60_000 }, /^Verification at h1 didn't finish within 60 minutes\.$/, "verification past the timeout");
handsOver({ ...auto, evidence: { state: "failed", sha: "h1", failed: ["lint"], passed: 3, total: 4 }, runner: { kind: "available" } }, /Checks failed at h1: lint/, "failed evidence is not re-run");

// --- GitHub parsing
const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
const none = { state: "pending", total_count: 0 };
const PENDING = { state: "pending" } as const;
assert.deepEqual(checkStateOf([], none), { checks: "pending", bugbot: PENDING }, "nothing reported yet is pending");
assert.deepEqual(checkStateOf([run("ci", "completed", "success"), run("Cursor Bugbot", "completed", "neutral")], none), { checks: "success", bugbot: { state: "reviewed" } }, "neutral: reviewed, findings posted");
assert.deepEqual(checkStateOf([run("Cursor Bugbot", "completed", "success")], none).bugbot, { state: "reviewed" }, "success: reviewed, nothing found");
for (const conclusion of ["failure", "timed_out", "cancelled", "action_required", "stale", "skipped"]) {
  assert.deepEqual(checkStateOf([run("Cursor Bugbot", "completed", conclusion)], none).bugbot, { state: "failed", conclusion }, `Bugbot ${conclusion} is no review`);
}
handsOver({ pr: facts({ bugbot: { review: { state: "failed", conclusion: "timed_out" }, findings: [] } }) }, /^Bugbot didn't complete its review \(timed_out\)\.$/, "a crashed Bugbot with no threads");
assert.equal(checkStateOf([run("ci", "completed", "success")], { state: "success", total_count: 1 }, false).checks, "pending", "an incomplete listing is never green");
assert.equal(checkStateOf([run("ci", "completed", "success"), run("Cursor Bugbot", "completed", "failure")], none).checks, "success", "Bugbot's own conclusion is not a check");
assert.equal(checkStateOf([run("ci", "in_progress", null)], none).checks, "pending");
assert.equal(checkStateOf([run("ci", "completed", "success"), run("lint", "completed", "timed_out")], none).checks, "failure");
assert.equal(checkStateOf([run("ci", "completed", "skipped")], { state: "failure", total_count: 1 }).checks, "failure", "a failed commit status counts");
assert.equal(checkStateOf([], { state: "success", total_count: 2 }).checks, "success", "statuses alone are enough");
assert.deepEqual(checkStateOf([run("Cursor Bugbot", "in_progress", null)], { state: "success", total_count: 1 }), { checks: "success", bugbot: PENDING });

const thread = (login: string | null, body: string, isResolved = false) => ({ isResolved, comments: { nodes: [{ author: login ? { login } : null, body }] } });
const graph = (nodes: unknown[]) => ({ data: { repository: { pullRequest: { reviewThreads: { nodes } } } } });
assert.deepEqual(
  bugbotFindingsOf(
    graph([
      thread("cursor", "### Bug\n\n**High Severity**\n\nx"),
      thread("cursor[bot]", "**Medium Severity** y", true),
      thread("cursor", "**Low Severity** z"),
      thread("someone", "**High Severity** quoted by a human"),
      thread("cursor", "a note with no severity"),
      thread(null, "**High Severity** ghost"),
    ]),
  ),
  [
    { severity: "high", resolved: false },
    { severity: "medium", resolved: true },
    { severity: "low", resolved: false },
  ],
  "only Bugbot's threads with a stated severity count",
);

const seen: string[] = [];
const filePage = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ filename: `f${from + i}.ts`, additions: 1, deletions: 2 }));
const stub = await serve(0, async (request) => {
  const url = new URL(request.url);
  seen.push(`${request.method} ${url.pathname}${url.search}`);
  if (url.pathname === "/repos/o/r/pulls/9") return Response.json({ state: "open", merged_at: null, closed_at: null, mergeable: true, head: { sha: "h9" }, base: { ref: "main" } });
  if (url.pathname === "/repos/o/r/pulls/9/files") return Response.json(url.searchParams.get("page") === "1" ? filePage(100, 0) : filePage(3, 100));
  if (url.pathname === "/repos/o/r/compare/main...h9") return Response.json({ behind_by: 4 });
  if (url.pathname === "/repos/o/r/commits/h9/check-runs") return Response.json({ total_count: 1, check_runs: [run("ci", "completed", "success")] });
  if (url.pathname === "/repos/o/r/commits/h9/status") return Response.json({ state: "pending", total_count: 0 });
  // 101 check runs: a failure on page two, or a page two GitHub never returns.
  const page = Number(url.searchParams.get("page"));
  const greens = Array.from({ length: 100 }, (_, i) => run(`ci-${i}`, "completed", "success"));
  if (url.pathname === "/repos/o/r/commits/h10/check-runs") return Response.json({ total_count: 101, check_runs: page === 1 ? greens : [run("e2e", "completed", "failure")] });
  if (url.pathname === "/repos/o/r/commits/h11/check-runs") return Response.json({ total_count: 101, check_runs: page === 1 ? greens : [] });
  if (url.pathname === "/repos/o/r/commits/h12/check-runs") return Response.json({ total_count: 0, check_runs: [] });
  if (/^\/repos\/o\/r\/commits\/h1[01]\/status$/.test(url.pathname)) return Response.json({ state: "success", total_count: 0, statuses: [] });
  if (url.pathname === "/repos/o/r/commits/h12/status") {
    const statuses = Array.from({ length: 100 }, (_, i) => ({ context: `s-${i}`, state: "success" }));
    return Response.json({ state: "failure", total_count: 101, statuses: page === 1 ? statuses : [{ context: "ci/late", state: "failure" }] });
  }
  if (url.pathname === "/graphql") {
    const body = (await request.json()) as { variables: { number: number } };
    if (body.variables.number === 10) return Response.json({ errors: [{ message: "Something went wrong" }] });
    return Response.json(graph([thread("cursor", "**High Severity**")]));
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
});
try {
  const client = pullsClient({ api: `http://localhost:${stub.port}`, tokens: { get: async () => "ghs_stub", evict: () => {} } });
  assert.deepEqual(await client.pullDetail("https://github.com/o/r/pull/9"), { state: "open", mergeable: "mergeable", headSha: "h9", baseRef: "main" });
  assert.equal(await client.behindBy("o/r", "main", "h9"), 4);
  const files = await client.pullFiles("https://github.com/o/r/pull/9");
  assert.equal(files.length, 103, "files page until a short page");
  assert.deepEqual(files[0], { path: "f0.ts", previousPath: undefined, additions: 1, deletions: 2, patch: undefined });
  assert.deepEqual(await client.checkState("o/r", "h9"), { checks: "success", bugbot: PENDING });
  assert.equal((await client.checkState("o/r", "h10")).checks, "failure", "a failed run past the first page counts");
  assert.equal((await client.checkState("o/r", "h11")).checks, "pending", "runs GitHub listed but never returned are not green");
  assert.deepEqual(await client.commitChecks("o/r", "h12"), { checks: "failure", failed: ["ci/late"] }, "statuses page too");
  assert.deepEqual(await client.bugbotFindings("https://github.com/o/r/pull/9"), [{ severity: "high", resolved: false }]);
  await assert.rejects(client.bugbotFindings("https://github.com/o/r/pull/10"), /GitHub GraphQL: Something went wrong/, "a GraphQL error is an error, not zero findings");
} finally {
  await stub.close();
}

// --- database: settings, ingest, runner pass
const stamp = Date.now() % 1_000_000;
const REPO = `regress/merge-${stamp}`;
const OFF_REPO = `regress/merge-off-${stamp}`;
const keys: string[] = [];
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${stamp}${n}`;
async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = `MD${name}-${stamp}`;
  keys.push(k);
  await db.insert(jobs).values(linearJob(`merge-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, repo: REPO, provider: "claudeAgent", ...over }));
  return k;
}
const auditsOf = async (k: string) => db.select().from(auditLog).where(eq(auditLog.job_id, (await row(k)).id));
const passedCheck = { name: "test" as const, command: "bun run test", exitCode: 0, startedAt: new Date(NOW).toISOString(), durationMs: 1200, outputTail: "ok", passed: true };
const verified = (k: string, sha: string) =>
  db.insert(jobEvidence).values({ job_key: k, sha, attempt: 1, repo: REPO, clean: true, producer: "agent", source: "package", checks: [passedCheck], event_id: `md-evidence-${k}-${sha}`, recorded_at: new Date() });

try {
  // Policy: defaults when unset; owner checks and validation live in repositories-regressions.
  assert.deepEqual(resolvePolicy(await readRepoSettings(db), REPO), DEFAULT_POLICY, "an unset repo is off with the defaults");
  await writeRepoAutonomy(db, { repo: REPO, autonomy: "trial" }, OWNER, new Date());
  assert.deepEqual(resolvePolicy(await readRepoSettings(db), REPO), { ...DEFAULT_POLICY, autonomy: "trial" });

  // Ingest: the pr report's assessment lands on the job and stays in the event.
  const INGEST = await insert("INGEST", { stage: "verifying", stage_at: new Date(Date.now() - 60_000) });
  const session = `merge-regress-session-${stamp}`;
  const stage = (n: number, body: Record<string, unknown>) =>
    eventSchema.parse({ kind: "stage", sessionId: session, eventId: `${session}-${n}`, at: Date.now() - 50_000 + n * 1000, jobKey: INGEST, branch: `factory/${INGEST}`, ...body });
  await ingest(db, [stage(1, { ...prReport, prUrl: prUrl(0), assessment: assessment() })]);
  assert.deepEqual((await row(INGEST)).merge_assessment, assessment(), "the job keeps the assessment");
  const [stored] = await db.select().from(events).where(eq(events.event_id, `${session}-1`));
  assert.deepEqual((stored!.payload as { assessment: unknown }).assessment, assessment(), "and so does the event");
  await ingest(db, [stage(2, { stage: "implementing", summary: "conflict" })]);
  assert.deepEqual((await row(INGEST)).merge_assessment, assessment(), "another stage leaves it");
  const second = assessment({ recommendation: "handover", reviewFocus: "The sort order" });
  await ingest(db, [stage(3, { ...prReport, prUrl: prUrl(0), assessment: second })]);
  assert.deepEqual((await row(INGEST)).merge_assessment, second, "the latest pr report wins");
  await ingest(db, [stage(4, { stage: "implementing", summary: "again" }), stage(5, { ...prReport, prUrl: prUrl(0) })]);
  assert.equal((await row(INGEST)).merge_assessment, null, "a pr report without one clears it");

  // The runner pass, against stubbed GitHub and Linear.
  hosts.wake = async (job) => {
    throw new Error(`woke ${job.key}`);
  };
  const heads = new Map<string, string>();
  const calls: string[] = [];
  github.pullDetail = async (url) => (calls.push(`detail ${url}`), { state: "open", mergeable: "mergeable", headSha: heads.get(url) ?? "h1", baseRef: "main" });
  github.behindBy = async () => (calls.push("behind"), 0);
  github.pullFiles = async () => (calls.push("files"), [{ path: "src/list.tsx", additions: 5, deletions: 1 }]);
  let checks: "success" | "pending" = "success";
  github.checkState = async () => (calls.push("checks"), { checks, bugbot: { state: "reviewed" as const } });
  github.bugbotFindings = async () => (calls.push("bugbot"), []);
  const labels = new Map<string, string[]>();
  SOURCES.linear.labels = async (job) => (calls.push(`labels ${job.key}`), labels.get(job.key) ?? ["factory"]);
  const commented: string[] = [];
  github.upsertComment = async (url) => (commented.push(`pr ${url}`), "created");
  SOURCES.linear.note = async (job) => void commented.push(`note ${job.key}`);
  // auto-merge-regressions covers the merge itself; here the head always moves away first.
  github.mergeCandidate = async () => ({ state: "open", headSha: "moved", baseRef: "main", title: "t", number: 1, commits: 1, mergeCommitSha: null, mergedByBot: false });

  const at = (minutes: number) => NOW + minutes * 60_000;
  const prEvent = (k: string) => `merge-regress-pr-${k}`;
  const GOOD = await insert("GOOD", { stage: "pr", pr_url: prUrl(1), stage_event_id: prEvent("GOOD"), merge_assessment: assessment() });
  const ASLEEP = await insert("ASLEEP", { stage: "pr", pr_url: prUrl(2), sandbox_id: null, sandbox_snapshot: "im-snap-merge", merge_assessment: assessment() });
  const LABELED = await insert("LABELED", { stage: "pr", pr_url: prUrl(3), merge_assessment: assessment() });
  const OFF = await insert("OFF", { stage: "pr", pr_url: prUrl(4), repo: OFF_REPO });
  const CODEX = await insert("CODEX", { stage: "pr", pr_url: prUrl(5), provider: "codex", merge_assessment: assessment() });
  const WORKING = await insert("WORKING", { stage: "implementing", pr_url: prUrl(6) });
  const UNCOUNTED = await insert("UNCOUNTED", { stage: "pr", pr_url: prUrl(7), provider: "codex", merge_assessment: assessment() });
  const UNPRICED = await insert("UNPRICED", { stage: "pr", pr_url: prUrl(8), provider: "codex", merge_assessment: assessment() });
  const PRICEY = await insert("PRICEY", { stage: "pr", pr_url: prUrl(9), provider: "codex", merge_assessment: assessment() });
  labels.set(LABELED, ["factory", "review"]);
  for (const k of [GOOD, ASLEEP, LABELED, CODEX, UNCOUNTED, UNPRICED, PRICEY]) await verified(k, "h1");
  for (const k of [GOOD, ASLEEP, LABELED]) await db.insert(runs).values(usageRun(k));
  await db.insert(runs).values(usageRun(CODEX, "gpt-6.1-sol"));
  await db.insert(runs).values(usageRun(UNPRICED, "gpt-9-nova"));
  // 1M output tokens of gpt-6-astra: $50, over the $5 budget.
  await db.insert(runs).values(usageRun(PRICEY, "gpt-6-astra", { output: 1_000_000 }));
  const only = { only: [GOOD, ASLEEP, LABELED, OFF, CODEX, WORKING, UNCOUNTED, UNPRICED, PRICEY] };

  const first = await decideMerges({ ...only, now: at(0) });
  assert.deepEqual(
    Array.isArray(first) ? [...first].sort() : first,
    [`${GOOD}:merge`, `${ASLEEP}:merge`, `${LABELED}:handover`, `${OFF}:handover`, `${CODEX}:merge`, `${UNCOUNTED}:handover`, `${UNPRICED}:handover`, `${PRICEY}:handover`].sort(),
  );
  const good = (await row(GOOD)).merge_decision!;
  assert.deepEqual(
    { ...good, evaluatedAt: undefined, comments: undefined },
    {
      comments: undefined,
      outcome: "merge",
      reasons: [],
      autonomy: "trial",
      headSha: "h1",
      headSeenAt: new Date(at(0)).toISOString(),
      stageEventId: prEvent("GOOD"),
      evaluatedAt: undefined,
      evidence: { state: "verified", sha: "h1", passed: 1, total: 1, producer: "agent" },
      review: {
        headSha: "h1",
        fileCount: 1,
        files: [{ path: "src/list.tsx", additions: 5, deletions: 1 }],
        bugbot: { state: "reviewed", high: 0, medium: 0, low: 0, resolved: 0 },
      },
    },
  );
  assert.deepEqual((await row(ASLEEP)).sandbox_snapshot, "im-snap-merge", "a hibernated job is decided on GitHub alone and stays asleep");
  assert.deepEqual((await row(LABELED)).merge_decision!.reasons, ['The issue has the "review" label.']);
  assert.deepEqual((await row(OFF)).merge_decision, { outcome: "handover", reasons: [], autonomy: "off", headSha: null, headSeenAt: null, stageEventId: null, evaluatedAt: new Date(at(0)).toISOString() });
  assert.ok(!calls.some((c) => c.includes(prUrl(4)) || c.includes(OFF)), "an off repo asks neither GitHub nor Linear");
  assert.deepEqual((await row(CODEX)).merge_decision!.reasons, [], "a Codex run with a known cost under budget merges like Claude");
  assert.deepEqual((await row(UNCOUNTED)).merge_decision!.reasons, [COST_UNKNOWN_REASON], "a Codex run with no usage recorded hands over");
  assert.deepEqual((await row(UNPRICED)).merge_decision!.reasons, [COST_UNKNOWN_REASON], "and so does one on a model with no price");
  assert.deepEqual((await row(PRICEY)).merge_decision!.reasons, ["The run went over its budget."], "a Codex run over budget hands over");
  assert.equal((await row(WORKING)).merge_decision, null, "only jobs in pr");
  const [goodAudit] = await auditsOf(GOOD);
  assert.deepEqual([goodAudit!.action, goodAudit!.actor, goodAudit!.head_sha, goodAudit!.detail], ["merge_decided", "factory", "h1", "Would merge (trial)"]);

  // Unchanged: only the head is read, nothing is stored or audited.
  calls.length = 0;
  assert.deepEqual(await decideMerges({ ...only, now: at(2) }), []);
  assert.ok(calls.every((c) => c.startsWith("detail ")), JSON.stringify(calls));
  assert.equal((await auditsOf(GOOD)).length, 1);
  assert.equal((await row(GOOD)).merge_decision!.evaluatedAt, new Date(at(0)).toISOString());

  // A stale decision is evaluated again, but the same outcome is not audited again.
  assert.deepEqual(await decideMerges({ ...only, now: at(0) + RECHECK_MS + 1 }), []);
  assert.equal((await row(GOOD)).merge_decision!.evaluatedAt, new Date(at(0) + RECHECK_MS + 1).toISOString(), "the re-read is stored");
  assert.equal((await auditsOf(GOOD)).length, 1, "but not audited");

  // A new head: recomputed, pending while checks run, then a handover once they time out.
  heads.set(prUrl(1), "h2");
  await verified(GOOD, "h2");
  checks = "pending";
  const t1 = at(30);
  assert.deepEqual(await decideMerges({ only: [GOOD], now: t1 }), [`${GOOD}:pending`]);
  const moved = (await row(GOOD)).merge_decision!;
  assert.deepEqual([moved.headSha, moved.headSeenAt, moved.reasons], ["h2", new Date(t1).toISOString(), ["Waiting for checks."]]);
  assert.deepEqual(await decideMerges({ only: [GOOD], now: t1 + 5 * 60_000 }), [], "pending is read every pass, with no new audit while it holds");
  assert.equal((await row(GOOD)).merge_decision!.headSeenAt, new Date(t1).toISOString(), "the timeout runs from when the head was first seen");
  assert.deepEqual(await decideMerges({ only: [GOOD], now: t1 + 61 * 60_000 }), [`${GOOD}:handover`]);
  assert.deepEqual((await row(GOOD)).merge_decision!.reasons, ["Checks didn't finish within 60 minutes."]);
  assert.equal((await auditsOf(GOOD)).length, 3);

  // Autonomy and a new report both force a fresh decision.
  checks = "success";
  await writeRepoAutonomy(db, { repo: REPO, autonomy: "auto" }, OWNER, new Date());
  assert.deepEqual(await decideMerges({ only: [LABELED], now: at(40) }), [`${LABELED}:handover`], "the review label still holds under auto");
  assert.equal((await row(LABELED)).merge_decision!.autonomy, "auto");
  await db.update(jobs).set({ stage_event_id: "merge-regress-new-report" }).where(eq(jobs.key, GOOD));
  assert.deepEqual(await decideMerges({ only: [GOOD], now: t1 + 62 * 60_000 }), [`${GOOD}:merge`]);
  assert.deepEqual((await row(GOOD)).merge_decision!.reasons, []);

  // A job that left pr meanwhile keeps no decision written for the old report.
  github.pullDetail = async (url) => {
    await db.update(jobs).set({ stage: "implementing", stage_event_id: "merge-regress-conflict" }).where(eq(jobs.pr_url, url));
    return { state: "open", mergeable: "mergeable", headSha: "h3", baseRef: "main" };
  };
  const before = (await row(ASLEEP)).merge_decision;
  assert.deepEqual(await decideMerges({ only: [ASLEEP], now: at(50) }), []);
  assert.deepEqual((await row(ASLEEP)).merge_decision, before, "the guarded update skips it");

  console.log("merge decision regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(like(jobs.id, `${jobId("linear", "merge-regress-")}%`))).map((j) => j.id);
  if (ids.length > 0) await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
  if (keys.length > 0) await db.delete(events).where(inArray(events.job_key, keys));
  if (keys.length > 0) await db.delete(jobEvidence).where(inArray(jobEvidence.job_key, keys));
  if (keys.length > 0) await db.delete(runs).where(inArray(runs.job_key, keys));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "merge-regress-")}%`));
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [REPO, OFF_REPO]));
  process.exit(process.exitCode ?? 0);
}
