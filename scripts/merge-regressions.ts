import "./test-guard";
import assert from "node:assert/strict";
import { asc, eq, like, sql } from "drizzle-orm";
import type { JobId } from "../lib/sources/shapes";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { auditLog, jobs } = await import("../db/schema");
const { pullsClient } = await import("../lib/github/pulls");
const { appCredentials } = await import("../lib/github/app");
const { mergeJob, mergeTarget } = await import("../lib/merge");
const { linearJob } = await import("./fixtures");
const { serve } = await import("./serve");

type Pull = { head: string; state: "open" | "closed"; merged?: boolean; mergeable: boolean | null; title: string };
const pulls = new Map<number, Pull>();
const mergeCalls: { number: number; sha: string }[] = [];
let mergeAnswer: (number: number) => { status: number; body: unknown } = () => ({ status: 200, body: { sha: "squash-sha-1234567" } });
let mergeDelayMs = 0;

const server = await serve(0, async (request: Request) => {
    const url = new URL(request.url);
    const match = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)(\/merge)?$/.exec(url.pathname);
    const pull = match && pulls.get(Number(match[1]));
    if (!match || !pull) return Response.json({ message: "Not Found" }, { status: 404 });
    if (match[2] && request.method === "PUT") {
      const { sha } = (await request.json()) as { sha: string };
      mergeCalls.push({ number: Number(match[1]), sha });
      await new Promise((resolve) => setTimeout(resolve, mergeDelayMs));
      const answer = mergeAnswer(Number(match[1]));
      if (answer.status === 200) Object.assign(pull, { state: "closed", merged: true });
      return Response.json(answer.body, { status: answer.status });
    }
    return Response.json({
      state: pull.state,
      merged_at: pull.merged ? "2026-10-25T00:00:00Z" : null,
      closed_at: null,
      head: { sha: pull.head },
      mergeable: pull.mergeable,
      title: pull.title,
    });
});

const github = pullsClient({ api: `http://localhost:${server.port}`, tokens: { get: async () => "test-token", evict: () => {} } });
const owner = { email: OWNER, emailVerified: true };
const deps = (user: { email: string; emailVerified: boolean } | null = owner) => ({ db, pulls: github, user: async () => user });

const prefix = `merge-regress-${Date.now()}`;
let n = 0;
async function prJob(pull: Partial<Pull> = {}, stage: "pr" | "implementing" = "pr") {
  n++;
  const number = 1000 + n;
  pulls.set(number, { head: `head-${n}`, state: "open", mergeable: true, title: `PR ${n}`, ...pull });
  const key = `${prefix}-${n}`;
  const row = linearJob(key, key, { stage, pr_url: `https://github.com/ski043/factory-demo/pull/${number}` });
  await db.insert(jobs).values(row);
  return { id: row.id, number, head: pulls.get(number)!.head };
}
const auditOf = async (jobId: JobId) =>
  (await db.select().from(auditLog).where(eq(auditLog.job_id, jobId)).orderBy(asc(auditLog.at))).map((r) => ({
    action: r.action,
    result: r.result,
    actor: r.actor,
    head: r.head_sha,
  }));
const callsFor = (number: number) => mergeCalls.filter((c) => c.number === number).length;

try {
  {
    const job = await prJob();
    for (const user of [null, { email: "someone@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
      const outcome = await mergeJob(deps(user), job.id, job.head);
      assert.deepEqual([outcome.ok, !outcome.ok && outcome.status], [false, 403], `a non-owner (${user?.email ?? "signed out"}) is refused with 403`);
    }
    assert.deepEqual(await auditOf(job.id), [], "a non-owner writes no audit row");
    assert.equal(callsFor(job.number), 0, "and GitHub is not asked");
    assert.equal(await mergeTarget(deps(null), job.id), null, "a non-owner gets no merge target");
  }

  {
    const job = await prJob({}, "implementing");
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.equal(!outcome.ok && outcome.reason, "refused", "a job outside pr is refused");
    assert.deepEqual(await auditOf(job.id), [{ action: "merge_failed", result: "refused", actor: OWNER, head: job.head }]);
    assert.equal(callsFor(job.number), 0);
    assert.equal(await mergeTarget(deps(), job.id), null, "a job outside pr has no merge target");
  }

  {
    const job = await prJob();
    assert.deepEqual(
      await mergeTarget(deps(), job.id),
      { title: `PR ${n}`, headSha: job.head, repo: "ski043/factory-demo", prUrl: `https://github.com/ski043/factory-demo/pull/${job.number}`, mergeable: "mergeable" },
      "the dialog gets the title, head and repo",
    );
    pulls.get(job.number)!.head = "pushed-later";
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.equal(!outcome.ok && outcome.reason, "head_moved", "a push after the panel loaded stops the merge");
    assert.deepEqual(await auditOf(job.id), [{ action: "merge_failed", result: "head_moved", actor: OWNER, head: job.head }], "merge_failed records head_moved");
    assert.equal(callsFor(job.number), 0, "and GitHub is not asked to merge");
  }

  {
    const job = await prJob({ mergeable: false });
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.equal(!outcome.ok && outcome.reason, "not_mergeable", "a conflicting PR is refused");
    assert.deepEqual(await auditOf(job.id), [{ action: "merge_failed", result: "not_mergeable", actor: OWNER, head: job.head }]);
    assert.equal(callsFor(job.number), 0);
  }

  {
    const job = await prJob();
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.deepEqual(outcome, { ok: true, sha: "squash-sha-1234567" }, "an owner merges a mergeable PR at the head they saw");
    assert.deepEqual(mergeCalls.filter((c) => c.number === job.number), [{ number: job.number, sha: job.head }], "GitHub is asked once, pinned to that head");
    assert.deepEqual(
      await auditOf(job.id),
      [
        { action: "merge_requested", result: null, actor: OWNER, head: job.head },
        { action: "merge_succeeded", result: "ok", actor: OWNER, head: job.head },
      ],
      "a success writes the request and then the success",
    );
  }

  {
    const job = await prJob();
    // Two warm connections, so neither click waits on a new TLS handshake and both reach the lock.
    await Promise.all([db.execute(sql`select pg_sleep(0.05)`), db.execute(sql`select pg_sleep(0.05)`)]);
    mergeDelayMs = 1000;
    const both = await Promise.all([mergeJob(deps(), job.id, job.head), mergeJob(deps(), job.id, job.head)]);
    mergeDelayMs = 0;
    assert.equal(callsFor(job.number), 1, "a double click makes one merge call");
    assert.deepEqual(both.map((o) => (o.ok ? "ok" : o.reason)).sort(), ["in_progress", "ok"], "the second click finds the first one running");
    assert.equal((await auditOf(job.id)).filter((r) => r.action === "merge_requested").length, 1, "and the audit has one merge_requested");
  }

  {
    const job = await prJob();
    mergeAnswer = () => ({ status: 405, body: { message: "Pull Request is not mergeable" } });
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.equal(!outcome.ok && outcome.reason, "not_mergeable", "GitHub refusing the merge is not_mergeable");
    assert.deepEqual((await auditOf(job.id)).map((r) => `${r.action}:${r.result}`), ["merge_requested:null", "merge_failed:not_mergeable"]);
    mergeAnswer = () => ({ status: 409, body: { message: "Head branch was modified" } });
    const raced = await mergeJob(deps(), job.id, job.head);
    assert.equal(!raced.ok && raced.reason, "head_moved", "a push between the check and the merge is head_moved");
    mergeAnswer = () => ({ status: 500, body: { message: "boom" } });
    const broken = await mergeJob(deps(), job.id, job.head);
    assert.equal(!broken.ok && broken.reason, "error", "a GitHub failure is recorded as error");
    assert.deepEqual(
      (await auditOf(job.id)).slice(-2).map((r) => `${r.action}:${r.result}`),
      ["merge_requested:null", "merge_failed:error"],
      "and the request that failed is closed by its failure, so a retry is not stuck in progress",
    );
    mergeAnswer = () => ({ status: 200, body: { sha: "squash-sha-1234567" } });
    assert.equal((await mergeJob(deps(), job.id, job.head)).ok, true, "a retry after a failure merges");
    pulls.get(job.number)!.state = "open";
    const again = await mergeJob(deps(), job.id, job.head);
    assert.equal(!again.ok && again.reason, "refused", "a commit merged from the panel is not merged twice, even while GitHub still calls it open");
    assert.equal(callsFor(job.number), 4, "and GitHub is not asked again");
  }

  {
    const job = await prJob({ state: "closed", merged: true });
    const outcome = await mergeJob(deps(), job.id, job.head);
    assert.equal(!outcome.ok && outcome.reason, "refused", "an already merged PR is refused");
    assert.equal(callsFor(job.number), 0);
  }

  assert.deepEqual(appCredentials({ GITHUB_APP_ID: "5459681", GITHUB_APP_PRIVATE_KEY: "pem" }), { client_id: "5459681", pem: "pem" }, "Vercel signs with the env key");
  assert.throws(() => appCredentials({ GITHUB_APP_PRIVATE_KEY: "pem" }), /GITHUB_APP_ID is not/, "a key without an app id is refused");

  console.log("merge regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(auditLog).where(like(auditLog.job_id, `linear:${prefix}%`));
  await db.delete(jobs).where(like(jobs.key, `${prefix}%`));
  await server.close();
  process.exit(process.exitCode ?? 0);
}
