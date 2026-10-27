import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";

const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts } = await import("../lib/host");
const { github } = await import("../lib/github/pulls");
const { checkPullRequests, config, ingestClient, resumeAnswered, threads } = await import("../runner/ops");
const { inferUntracked, questionFrom } = await import("../runner/untracked");
type ThreadRead = Awaited<ReturnType<typeof threads.read>>;

const stamp = Date.now() % 1_000_000;
const key = (name: string) => `UT${name}-${stamp}`;
const keys: string[] = [];
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const hourAgo = new Date(Date.now() - 3_600_000);
const later = () => Date.now() + (config.factory.stoppedGraceMinutes + 1) * 60_000;
const prUrl = (n: number) => `https://github.com/ski043/factory-demo/pull/${stamp}${n}`;

async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = key(name);
  keys.push(k);
  await db.insert(jobs).values(linearJob(`untracked-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, stage: "queued", provider: "codex", t3_thread_id: `thread-${k}`, updated_at: hourAgo, ...over }));
  return k;
}

// Runner events go through the ingest projection itself, as the deployed function would apply them.
let ingestDown = false;
ingestClient.post = async (event) => {
  if (ingestDown) throw new Error("ingest is down");
  return ingest(db, [eventSchema.parse(event)]);
};
const lookedUp: string[] = [];
const prs = new Map<string, { url: string; state: "open" | "merged" }>();
github.pullRequestForBranch = async (_repo, branch) => (lookedUp.push(branch), prs.get(branch) ?? null);
const pullStates = new Map<string, Awaited<ReturnType<typeof github.pullRequest>>>();
github.pullRequest = async (url) => pullStates.get(url) ?? { state: "open", mergeable: "mergeable", headSha: "h", title: "t" };
const shown = new Map<string, ThreadRead>();
const read: string[] = [];
threads.read = async (threadId) => (read.push(threadId!), shown.get(threadId!) ?? { state: "running", status: "running", lastMessage: null });
const sent: { threadId: string; message: string }[] = [];
threads.send = async (threadId, message) => void sent.push({ threadId, message });
hosts.wake = async (job) => {
  throw new Error(`woke ${job.key}`);
};
const eventsOf = async (k: string) => (await db.select().from(events).where(eq(events.job_key, k))).map((e) => e.event_id).sort();

try {
  const PR = await insert("PR", {});
  const MERGED = await insert("MERGED", { stage: "implementing", stage_at: hourAgo });
  const DONE = await insert("DONE", { stage_at: hourAgo });
  const FRESH = await insert("FRESH", { stage: "triage", stage_at: new Date() });
  const FAILED = await insert("FAILED", { stage: "implementing", stage_at: hourAgo });
  const TRACKED = await insert("TRACKED", { provider: "claudeAgent", stage_at: hourAgo });
  const ASLEEP = await insert("ASLEEP", { stage_at: hourAgo, sandbox_snapshot: "im-snap-asleep" });
  const only = { only: keys.slice() };
  prs.set(`factory/${PR}`, { url: prUrl(1), state: "open" });
  prs.set(`factory/${MERGED}`, { url: prUrl(2), state: "merged" });
  prs.set(`factory/${TRACKED}`, { url: prUrl(3), state: "open" });
  shown.set(`thread-${DONE}`, { state: "stopped", status: "completed", lastMessage: "Done. The token ghs_abcdefghijklmnopqrstuvwxyz0123 did not work, so no PR. Should I use the v2 API?" });
  shown.set(`thread-${FRESH}`, { state: "stopped", status: "completed", lastMessage: "finished" });
  shown.set(`thread-${FAILED}`, { state: "stopped", status: "failed", lastMessage: "crashed" });
  shown.set(`thread-${ASLEEP}`, { state: "stopped", status: "completed", lastMessage: "x" });

  // A pass whose events cannot post changes nothing, and the next one posts them once.
  ingestDown = true;
  const down = await inferUntracked({ only: [PR] });
  assert.ok(!Array.isArray(down) && down.errors.some((e) => e.key === PR && /ingest is down/.test(e.error)), JSON.stringify(down));
  assert.equal((await row(PR)).stage, "queued");
  ingestDown = false;
  lookedUp.length = 0;
  read.length = 0;

  const first = await inferUntracked(only);
  assert.deepEqual(Array.isArray(first) ? [...first].sort() : first, [`${PR}:pr`, `${MERGED}:merged`, `${DONE}:waiting`, `${FAILED}:failed`].sort(), JSON.stringify(first));
  const pr = await row(PR);
  assert.deepEqual([pr.stage, pr.pr_url, pr.stage_summary], ["pr", prUrl(1), `Opened ${prUrl(1)}`], "an open PR on the attempt branch moves the job to pr with its URL");
  assert.match(pr.stage_event_id!, /^inferred:/);
  const merged = await row(MERGED);
  assert.deepEqual([merged.stage, merged.pr_url], ["merged", prUrl(2)], "a PR already merged goes straight to merged");
  assert.match(merged.stage_event_id!, /^merged:/, "through the merged path");
  const done = await row(DONE);
  assert.equal(done.stage, "waiting", "a thread that completed without a PR waits for the owner");
  assert.equal(done.question, "Done. The token [redacted] did not work, so no PR. Should I use the v2 API?", "with its last message as the question, token masked");
  assert.equal((await row(FRESH)).stage, "triage", "a thread inside the grace may not have started its run yet");
  const failed = await row(FAILED);
  assert.deepEqual([failed.stage, failed.stage_summary], ["failed", "Watchdog stopped this run: its T3 thread failed (stage implementing)."], "a failed thread fails the job as the watchdog would");
  assert.match(failed.stage_event_id!, /^watchdog:/);
  assert.equal((await row(TRACKED)).stage, "queued", "a tracked harness reports its own stages");
  assert.ok(!lookedUp.includes(`factory/${TRACKED}`) && !read.includes(`thread-${TRACKED}`), "and is not looked up");
  const asleep = await row(ASLEEP);
  assert.deepEqual([asleep.stage, asleep.sandbox_snapshot], ["queued", "im-snap-asleep"], "a hibernated job is left asleep");
  assert.ok(!read.includes(`thread-${ASLEEP}`) && !lookedUp.includes(`factory/${ASLEEP}`), "and never read");

  const before = await Promise.all([PR, MERGED, DONE, FAILED].map(eventsOf));
  assert.deepEqual(before.map((ids) => ids.length), [1, 1, 1, 1], "one event per job");
  assert.deepEqual(await inferUntracked(only), [], "a second pass changes nothing");
  assert.deepEqual(await Promise.all([PR, MERGED, DONE, FAILED].map(eventsOf)), before, "and posts nothing");
  const runFor = async (k: string) => (await db.select().from(runs).where(eq(runs.job_key, k)))[0];
  assert.equal((await runFor(PR))?.pr_url, prUrl(1), "the run records the PR, as a reported pr would");

  // The PR merges: the PR check moves it on like any tracked job's.
  pullStates.set(prUrl(1), { state: "merged", mergeable: "unknown", headSha: "h", title: "t" });
  const checked = await checkPullRequests();
  assert.ok(!checked.errors.some((e) => keys.includes(e.key)), JSON.stringify(checked));
  assert.equal((await row(PR)).stage, "merged");

  // A conflict sends the thread back; once it settles again the job is back in pr with the same PR.
  const CONFLICT = await insert("CONFLICT", { stage: "pr", stage_at: hourAgo, pr_url: prUrl(4) });
  pullStates.set(prUrl(4), { state: "open", mergeable: "conflicting", headSha: "head-c", title: "t" });
  const sentBack = await checkPullRequests();
  assert.ok(sentBack.conflicts.includes(CONFLICT), JSON.stringify(sentBack));
  assert.equal((await row(CONFLICT)).stage, "implementing");
  assert.ok(sent.some((s) => s.threadId === `thread-${CONFLICT}` && /conflicts with main/.test(s.message)));
  pullStates.set(prUrl(4), { state: "open", mergeable: "mergeable", headSha: "head-d", title: "t" });
  assert.deepEqual(await inferUntracked({ only: [CONFLICT] }), [], "not while the thread may still be starting");
  shown.set(`thread-${CONFLICT}`, { state: "stopped", status: "completed", lastMessage: "Merged main." });
  assert.deepEqual(await inferUntracked({ only: [CONFLICT], now: later() }), [`${CONFLICT}:pr`]);
  assert.deepEqual([(await row(CONFLICT)).stage, (await row(CONFLICT)).pr_url], ["pr", prUrl(4)]);
  assert.ok(!lookedUp.includes(`factory/${CONFLICT}`), "a job with a PR is not looked up again");

  // The owner answers: the thread gets the answer, and a second settle without a PR asks again.
  SOURCES.linear.replies = async (job) =>
    job.key === DONE ? { kind: "resume", question: job.question!, replies: [{ id: `reply-${DONE}`, body: "Yes", createdAt: new Date().toISOString() }], answer: "Yes" } : { kind: "wait" };
  SOURCES.linear.acknowledgeReplies = async () => {};
  const resumed = await resumeAnswered();
  assert.ok(resumed.includes(`${DONE}:sent`), JSON.stringify(resumed));
  assert.equal((await row(DONE)).stage, "queued");
  assert.ok(sent.some((s) => s.threadId === `thread-${DONE}` && s.message.includes("Yes")), "the answer goes to the same thread");
  shown.set(`thread-${DONE}`, { state: "stopped", status: "interrupted", lastMessage: null });
  assert.deepEqual(await inferUntracked({ only: [DONE], now: later() }), [`${DONE}:waiting`]);
  const again = await row(DONE);
  assert.equal(again.question, questionFrom(null, "interrupted"), "with a fallback question when it left no message");
  assert.equal((await eventsOf(DONE)).filter((id) => id.startsWith("inferred:")).length, 2, "each settle is its own event");

  // A stage the agent reported through the MCP server stands within the grace: its own pr report,
  // with the assessment, comes first. After the grace the gap is filled as before.
  const REPORTED = await insert("REPORTED", {});
  const mcpReport = { sessionId: `mcp:factory/${REPORTED}`, kind: "stage", jobKey: REPORTED, branch: `factory/${REPORTED}` } as const;
  await ingest(db, [eventSchema.parse({ ...mcpReport, eventId: `abc${stamp}verifying`, at: Date.now(), stage: "verifying", summary: "Running the checks." })]);
  assert.equal((await row(REPORTED)).stage, "verifying");
  prs.set(`factory/${REPORTED}`, { url: prUrl(5), state: "open" });
  shown.set(`thread-${REPORTED}`, { state: "stopped", status: "completed", lastMessage: "Opened the PR." });
  lookedUp.length = 0;
  assert.deepEqual(await inferUntracked({ only: [REPORTED] }), [], "inference does not override a stage reported inside the grace");
  assert.ok(!lookedUp.includes(`factory/${REPORTED}`), "nor looks for its PR yet");
  await ingest(db, [eventSchema.parse({ ...mcpReport, eventId: `abc${stamp}pr`, at: Date.now(), stage: "pr", summary: "PR is up.", prUrl: prUrl(5) })]);
  assert.deepEqual(await inferUntracked({ only: [REPORTED], now: later() }), [], "a job the agent moved to pr is no longer inferred");
  const reported = await row(REPORTED);
  assert.deepEqual([reported.stage, reported.stage_summary, reported.stage_event_id], ["pr", "PR is up.", `abc${stamp}pr`], "the reported pr stands");

  const GAP = await insert("GAP", {});
  await ingest(db, [eventSchema.parse({ ...mcpReport, sessionId: `mcp:factory/${GAP}`, jobKey: GAP, branch: `factory/${GAP}`, eventId: `abc${stamp}gap`, at: Date.now(), stage: "implementing", summary: "Building it." })]);
  prs.set(`factory/${GAP}`, { url: prUrl(6), state: "open" });
  assert.deepEqual(await inferUntracked({ only: [GAP] }), [], "inside the grace the reported stage stands");
  assert.deepEqual(await inferUntracked({ only: [GAP], now: later() }), [`${GAP}:pr`], "past it, a PR the agent never reported fills the gap");
  const gap = await row(GAP);
  assert.deepEqual([gap.stage, gap.session_id], ["pr", null]);
  assert.ok((await eventsOf(GAP)).some((id) => id.startsWith("inferred:")));

  assert.equal(questionFrom("x".repeat(3000), "completed").length, 2000, "a long message is cut to what a stage report takes");

  console.log("untracked regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (keys.length > 0) {
    await db.delete(events).where(inArray(events.job_key, keys));
    await db.delete(runs).where(inArray(runs.job_key, keys));
  }
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "untracked-regress-")}%`));
  process.exit(process.exitCode ?? 0);
}
