import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs } = await import("../db/schema");
const { jobId } = await import("../lib/sources");
const { linearJob } = await import("./fixtures");
const { claimConflict, unclaimedRunsWithPr } = await import("../lib/conflicts");
const { runs } = await import("../db/schema");
const { checkPullRequests, pullRequestsSettled, threads } = await import("../runner/ops");
const { github } = await import("../lib/github/pulls");
type PullRequest = Awaited<ReturnType<typeof github.pullRequest>>;

const id = `conflict-regress-${Date.now()}`;
const jid = jobId("linear", id);
await db.insert(jobs).values(linearJob(id, id, { stage: "pr" }));
try {
  assert.equal(await claimConflict(db, jid, "head-1"), true, "a new conflicting head is sent back");
  assert.equal(await claimConflict(db, jid, "head-1"), false, "the same head is never sent back twice");
  await db.update(jobs).set({ stage: "implementing" }).where(eq(jobs.id, jid));
  assert.equal(await claimConflict(db, jid, "head-2"), false, "a job that left pr is not sent back");
  await db.update(jobs).set({ stage: "pr" }).where(eq(jobs.id, jid));
  assert.equal(await claimConflict(db, jid, "head-2"), true, "a later head that conflicts again is sent back");
  const at = new Date();
  const loose = { session_id: `${id}-loose`, job_key: `${id}-LOOSE`, pr_url: "https://x/pull/1", stage: "pr" as const, started_at: at, last_event_at: at };
  await db.insert(runs).values([loose, { ...loose, session_id: `${id}-claimed`, job_key: id }]);
  const picked = (await unclaimedRunsWithPr(db)).map((r) => r.session_id);
  assert.ok(picked.includes(`${id}-loose`), "a hand-started run with a PR is checked for a merge");
  assert.ok(!picked.includes(`${id}-claimed`), "a claimed job's run is left to the job path");

  const prUrl = `https://github.com/ski043/factory-demo/pull/${Date.now()}`;
  await db.update(jobs).set({ stage: "pr", pr_url: prUrl, conflict_head: null, t3_thread_id: "thread-1" }).where(eq(jobs.id, jid));
  let ours: PullRequest = { state: "open", mergeable: "unknown", headSha: "head-3" };
  github.pullRequest = async (url) => (url === prUrl ? ours : { state: "open", mergeable: "mergeable", headSha: "other" });
  const sent: string[] = [];
  threads.state = async () => "running";
  threads.send = async (threadId) => void sent.push(threadId);
  assert.equal(await pullRequestsSettled(), false, "an unknown mergeable keeps a recheck waiting");
  ours = { ...ours, mergeable: "conflicting" };
  assert.equal(await pullRequestsSettled(), true, "a computed mergeable settles it");
  await assert.rejects(checkPullRequests(), /deployed ingest function/, "a conflicting PR in stage pr is sent back, then posted as implementing");
  assert.deepEqual(sent, ["thread-1"], "its thread is told to merge main");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!.conflict_head, "head-3", "the head is claimed");
  assert.deepEqual(await checkPullRequests(), [], "a second pass over the same head does nothing");
  assert.deepEqual(sent, ["thread-1"], "and sends nothing");
  console.log("conflict regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(eq(jobs.id, jid));
  await db.delete(runs).where(inArray(runs.session_id, [`${id}-loose`, `${id}-claimed`]));
  process.exit(process.exitCode ?? 0);
}
