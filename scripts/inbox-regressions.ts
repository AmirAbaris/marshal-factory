import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { eq, inArray, like } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { MergeAssessment } from "../lib/assessment";
import type { MergeDecision } from "../lib/merge-decision";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const SECRET = "inbox-webhook-secret";
process.env.GITHUB_APP_WEBHOOK_SECRET = SECRET;

const { db } = await import("../db/client");
const { auditLog, events, intents, jobs, repoSettings, webhookDeliveries } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { hosts, localHost } = await import("../lib/host");
const { github, pullsClient } = await import("../lib/github/pulls");
const { writeRepoAutonomy } = await import("../lib/settings");
const { allows, changesMessage, feedbackDetailSchema, inboxItems, inboxKind, isDismissed } = await import("../lib/inbox");
const { approvalBlockers, reviewSummary } = await import("../lib/merge-decision");
const { githubIntent } = await import("../lib/webhooks");
const inbox = await import("../lib/inbox-actions");
const { approveMerge } = await import("../runner/merge-decision");
const { closeJob, requestChanges } = await import("../runner/inbox");
const { ingestClient, threads } = await import("../runner/ops");
const { INTENT_ROUTES } = await import("../runner/intents");
const { serve } = await import("./serve");

// --- the inbox's rules, pure
const T = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000);
const decision = (over: Partial<MergeDecision>): MergeDecision => ({
  outcome: "handover",
  reasons: [],
  autonomy: "auto",
  evaluatedAt: T(0).toISOString(),
  headSha: "h",
  headSeenAt: null,
  stageEventId: null,
  ...over,
});
const fake = (key: string, over: Partial<JobRow>) =>
  ({ key, stage: "implementing", stage_at: T(0), updated_at: T(0), pr_url: null, merge_decision: null, dismissed_at: null, question: null, stage_summary: null, ...over }) as JobRow;
const merged = { sha: "m", method: "squash" as const, at: T(0).toISOString(), base: "main", title: "t", commits: 1 };
const watch = (state: "watching" | "green" | "revert_failed") => ({ state, until: T(60).toISOString(), failed: ["ci"], revertPr: null, reason: state === "revert_failed" ? "git revert failed" : null });
const pool = [
  fake("Q-OLD", { stage: "waiting", stage_at: T(1), question: "Which one?" }),
  fake("Q-NEW", { stage: "waiting", stage_at: T(9) }),
  fake("REVERT", { stage: "merged", stage_at: T(5), merge_decision: decision({ merged, watch: watch("revert_failed") }) }),
  fake("GREEN", { stage: "merged", stage_at: T(6), merge_decision: decision({ merged, watch: watch("green") }) }),
  fake("OFF", { stage: "pr", stage_at: T(3), pr_url: "https://github.com/o/r/pull/1", merge_decision: decision({ autonomy: "off" }) }),
  fake("UNDECIDED", { stage: "pr", stage_at: T(4), pr_url: "https://github.com/o/r/pull/2" }),
  fake("HANDOVER", { stage: "pr", stage_at: T(2), pr_url: "https://github.com/o/r/pull/3", merge_decision: decision({ reasons: ["A check failed."] }) }),
  fake("TRIAL", { stage: "pr", stage_at: T(1), pr_url: "https://github.com/o/r/pull/4", merge_decision: decision({ outcome: "merge", autonomy: "trial" }) }),
  fake("PENDING", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/5", merge_decision: decision({ outcome: "pending" }) }),
  fake("AUTO", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/6", merge_decision: decision({ outcome: "merge" }) }),
  fake("MERGING", { stage: "pr", stage_at: T(8), pr_url: "https://github.com/o/r/pull/7", merge_decision: decision({ merging: { headSha: "h", method: "squash", at: T(8).toISOString() } }) }),
  fake("NOPR", { stage: "pr", stage_at: T(8) }),
  fake("FAILED", { stage: "failed", stage_at: T(7) }),
  fake("FAILED-OLD", { stage: "failed", stage_at: T(2) }),
  fake("DISMISSED", { stage: "failed", stage_at: T(3), dismissed_at: T(4) }),
  fake("FAILED-AGAIN", { stage: "failed", stage_at: T(5), dismissed_at: T(4) }),
  fake("REVERT-DISMISSED", { stage: "merged", stage_at: T(5), dismissed_at: T(6), merge_decision: decision({ merged, watch: watch("revert_failed") }) }),
  fake("WORKING", { stage: "implementing", stage_at: T(9) }),
];
assert.deepEqual(
  inboxItems(pool).map((i) => `${i.kind}:${i.job.key}`),
  [
    "question:Q-NEW",
    "revert_failed:REVERT",
    "question:Q-OLD",
    "handover:UNDECIDED",
    "handover:OFF",
    "handover:HANDOVER",
    "handover:TRIAL",
    "failed:FAILED",
    "failed:FAILED-AGAIN",
    "failed:FAILED-OLD",
  ],
  "questions and failed reverts, then handovers, then failures; newest first within; the factory's own work stays out",
);
assert.equal(isDismissed(pool.find((j) => j.key === "DISMISSED")!), true);
assert.equal(isDismissed(pool.find((j) => j.key === "FAILED-AGAIN")!), false, "a failure after the dismissal shows again");
assert.ok(allows("handover", "approve") && allows("handover", "request_changes") && allows("handover", "close"));
assert.ok(allows("revert_failed", "request_changes") && allows("revert_failed", "dismiss") && !allows("revert_failed", "approve"));
assert.ok(allows("failed", "dismiss") && allows("failed", "close") && !allows("failed", "request_changes"));
assert.ok(allows("question", "answer") && !allows("question", "approve") && !allows(null, "dismiss"));

assert.deepEqual(approvalBlockers({ checks: "success", mergeable: "mergeable", behindBy: 0 }), [], "green, clean and current: nothing blocks");
assert.deepEqual(approvalBlockers({ checks: "failure", mergeable: "conflicting", behindBy: 2 }), [
  "A check failed on the latest commit.",
  "The pull request conflicts with its base branch.",
  "The branch is 2 commits behind its base.",
]);
assert.deepEqual(approvalBlockers({ checks: "pending", mergeable: "unknown", behindBy: 0 }).length, 2, "running checks and unknown mergeability are facts too");
assert.deepEqual(
  reviewSummary({
    headSha: "h1",
    files: [{ path: "a.ts", additions: 3, deletions: 1, patch: "+x" }],
    bugbot: { review: { state: "reviewed" }, findings: [{ severity: "high", resolved: false }, { severity: "low", resolved: false }, { severity: "medium", resolved: true }] },
  }),
  { headSha: "h1", files: [{ path: "a.ts", additions: 3, deletions: 1 }], fileCount: 1, bugbot: { state: "reviewed", high: 1, medium: 0, low: 1, resolved: 1 } },
  "the summary keeps counts, not patches",
);

// GitHub reviews: a person's request for changes or comments is forwarded, keyed by the review.
const review = (over: Record<string, unknown> = {}, user: { login: string; type: string } | null = { login: "jan", type: "User" }) => ({
  action: "submitted",
  review: { id: 77, state: "changes_requested", body: "Rename the helper.", user, ...over },
  pull_request: { html_url: "https://github.com/o/r/pull/1" },
});
const forwarded = githubIntent("pull_request_review", review());
assert.equal(forwarded?.kind, "request_changes");
assert.equal(forwarded?.key, "review:77", "keyed by the review, not the delivery");
assert.deepEqual(feedbackDetailSchema.parse(JSON.parse(forwarded!.detail!)), { from: "github", id: "review:77", reviewId: 77, reviewer: "jan", state: "changes_requested", body: "Rename the helper." });
assert.equal(githubIntent("pull_request_review", review({ state: "commented", body: null }))?.kind, "request_changes", "inline comments alone are forwarded");
assert.equal(githubIntent("pull_request_review", review({}, { login: "cursor[bot]", type: "Bot" })), null, "Bugbot is not a reviewer");
assert.equal(githubIntent("pull_request_review", review({}, { login: "marshal-factory-ski043[bot]", type: "Bot" })), null, "nor is the factory's App");
assert.equal(githubIntent("pull_request_review", review({ state: "approved" })), null, "an approval asks for nothing");
assert.equal(githubIntent("pull_request_review", { ...review(), action: "edited" }), null, "an edit is not a new review");

const framed = changesMessage({ prUrl: "https://github.com/o/r/pull/1", feedback: { from: "panel", id: "panel:1", actor: OWNER, body: "Use the existing hook." } });
assert.match(framed, /^The reviewer requested changes on https:\/\/github\.com\/o\/r\/pull\/1:\n\n> Use the existing hook\.\n\nUpdate the same branch and PR, then report the PR again with a fresh assessment\.$/);

// --- fake GitHub
type Pull = { repo: string; number: number; head: string; state: "open" | "closed"; merged: string | null; mergeable: boolean; behind: number; checks: string; files: { filename: string; additions: number; deletions: number; patch?: string }[]; merge: { status: number; body: unknown } };
const pulls = new Map<string, Pull>();
const writes: { method: string; path: string; body: Record<string, unknown> }[] = [];
const keyOf = (repo: string, n: number) => `${repo}#${n}`;
const server = await serve(0, async (request) => {
  const path = new URL(request.url).pathname;
  const body = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  if (request.method !== "GET") writes.push({ method: request.method, path, body });
  let m: RegExpExecArray | null;
  if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return Response.json({ permissions: { push: true } });
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/files|\/merge|\/reviews\/\d+\/comments)?$/.exec(path))) {
    const p = pulls.get(keyOf(m[1]!, Number(m[2])));
    if (!p) return Response.json({ message: "Not Found" }, { status: 404 });
    if (m[3] === "/files") return Response.json(p.files);
    if (m[3]?.startsWith("/reviews")) return Response.json([{ path: "src/a.ts", line: 12, body: "This name is unclear." }]);
    if (m[3] === "/merge") {
      if (p.merge.status === 200) Object.assign(p, { state: "closed", merged: `merge-${p.number}` });
      return Response.json(p.merge.status === 200 ? { sha: `merge-${p.number}` } : p.merge.body, { status: p.merge.status });
    }
    if (request.method === "PATCH") p.state = body.state === "closed" ? "closed" : p.state;
    return Response.json({
      state: p.state,
      merged_at: p.merged ? T(0).toISOString() : null,
      closed_at: p.state === "closed" ? T(0).toISOString() : null,
      head: { sha: p.head },
      base: { ref: "main" },
      mergeable: p.mergeable,
      title: `Title ${p.number}`,
      commits: 1,
      merge_commit_sha: p.merged,
      merged_by: p.merged ? { login: "marshal-factory[bot]", type: "Bot" } : null,
    });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/compare\/main\.\.\.(.+)$/.exec(path))) {
    const p = [...pulls.values()].find((x) => x.head === m![2]);
    return Response.json({ behind_by: p?.behind ?? 0 });
  }
  if ((m = /\/commits\/([^/]+)\/(check-runs|status)$/.exec(path))) {
    const p = [...pulls.values()].find((x) => x.head === m![1]);
    const runs = [{ name: "ci", status: "completed", conclusion: p?.checks ?? "success" }, { name: "Cursor Bugbot", status: "completed", conclusion: "neutral" }];
    if (m[2] === "check-runs") return Response.json({ total_count: runs.length, check_runs: runs });
    return Response.json({ state: "success", total_count: 0, statuses: [] });
  }
  if (path === "/graphql") {
    const finding = { isResolved: false, comments: { nodes: [{ author: { login: "cursor" }, body: "**High Severity** bug" }] } };
    return Response.json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [finding] } } } } });
  }
  if (/\/issues\/\d+\/comments$/.test(path)) return request.method === "GET" ? Response.json([]) : Response.json({}, { status: 201 });
  return Response.json({ message: `no fake for ${request.method} ${path}` }, { status: 500 });
});
Object.assign(github, pullsClient({ api: `http://localhost:${server.port}`, tokens: { get: async () => "ghs_inbox_stub", evict: () => {} } }));

// --- threads, hosts and the source
const sent: { thread: string; message: string }[] = [];
let threadState: "running" | "stopped" | "gone" = "stopped";
let failSend = false;
threads.state = async () => threadState;
threads.send = async (thread, message) => {
  if (failSend) throw new Error("t3 thread send failed");
  sent.push({ thread, message });
};
const woken: string[] = [];
hosts.wake = async (job) => (woken.push(job.key), localHost);
ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
SOURCES.linear.labels = async () => ["factory"];
SOURCES.linear.note = async () => {};

// --- database
const stamp = Date.now() % 1_000_000;
const REPO = `regress/inbox-${stamp}`;
const keys: string[] = [];
const assessment: MergeAssessment = {
  recommendation: "handover",
  interpretation: "Rename the list.",
  assumptions: ["Nobody imports the old name."],
  checks: {
    interpretation: { ok: true, note: "fine" },
    proven: { ok: false, note: "No test covers the rename." },
    contained: { ok: true, note: "fine" },
    reversible: { ok: true, note: "fine" },
    noTasteCalls: { ok: true, note: "fine" },
    noSurprises: { ok: true, note: "fine" },
  },
  reviewFocus: "The rename",
};
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const prUrl = (n: number) => `https://github.com/${REPO}/pull/${n}`;
async function job(name: string, over: Partial<typeof jobs.$inferInsert>, pull?: Partial<Pull> & { number: number }) {
  const k = `INB${name}-${stamp}`;
  keys.push(k);
  if (pull) {
    pulls.set(keyOf(REPO, pull.number), { repo: REPO, head: `h${pull.number}`, state: "open", merged: null, mergeable: true, behind: 0, checks: "success", files: [{ filename: "src/list.tsx", additions: 5, deletions: 1 }], merge: { status: 200, body: {} }, ...pull });
  }
  await db.insert(jobs).values(
    linearJob(`inbox-regress-${k}`, k, {
      machine_id: TEST_MACHINE_ID,
      repo: REPO,
      provider: "claudeAgent",
      t3_thread_id: `thread-${k}`,
      session_id: `session-${k}`,
      stage_event_id: `inbox-regress-stage-${k}`,
      stage_at: new Date(),
      ...(pull && { stage: "pr" as const, pr_url: prUrl(pull.number), merge_assessment: assessment }),
      ...over,
    }),
  );
  return k;
}
const owner = { email: OWNER, emailVerified: true };
const stranger = { email: "someone@example.com", emailVerified: true };
const replies: { key: string; requestId: string; body: string }[] = [];
const deps = (user: typeof owner | null = owner) => ({ db, user: async () => user, reply: async (j: { key: string }, requestId: string, body: string) => void replies.push({ key: j.key, requestId, body }) });
const intentRows = (k: string) => db.select().from(intents).where(eq(intents.job_id, jobId("linear", `inbox-regress-${k}`)));
const putsTo = (n: number) => writes.filter((w) => w.method === "PUT" && w.path === `/repos/${REPO}/pulls/${n}/merge`);

try {
  await writeRepoAutonomy(db, { repo: REPO, autonomy: "off" }, OWNER, new Date());
  assert.equal(INTENT_ROUTES.approve_merge, "owner", "only the job's machine merges through its App");
  assert.equal(INTENT_ROUTES.request_changes, "owner", "and reaches its thread");

  // --- owner checks on every action
  const HAND = await job("HAND", {}, { number: 1, files: [{ filename: "drizzle/0099_x.sql", additions: 400, deletions: 10 }] });
  const handId = (await row(HAND)).id;
  const id1 = crypto.randomUUID();
  for (const user of [null, stranger, { ...owner, emailVerified: false }]) {
    assert.deepEqual(await inbox.approveMerge(deps(user), handId, id1, "h1"), { ok: false, message: "Only the factory owner can act on the inbox." });
    assert.equal((await inbox.requestChanges(deps(user), handId, id1, "x")).ok, false);
    assert.equal((await inbox.closeJob(deps(user), handId, id1, "")).ok, false);
    assert.equal((await inbox.dismissJob(deps(user), handId)).ok, false);
    assert.equal((await inbox.answerQuestion(deps(user), handId, id1, "x")).ok, false);
    assert.deepEqual(await inbox.intentOutcome(deps(user), `panel:approve_merge:${id1}`), { status: "failed", message: "Only the factory owner can act on the inbox." });
  }
  assert.equal((await intentRows(HAND)).length, 0, "a non-owner records nothing");
  assert.deepEqual(await inbox.approveMerge(deps(), handId, "not-a-uuid", "h1"), { ok: false, message: "The request is not valid." });
  assert.deepEqual(await inbox.requestChanges(deps(), handId, id1, "   "), { ok: false, message: "Write what should change." });
  assert.deepEqual(await inbox.dismissJob(deps(), handId), { ok: false, message: "Only a failed job can be dismissed." }, "a handover is not dismissed");
  assert.deepEqual(await inbox.answerQuestion(deps(), handId, id1, "yes"), { ok: false, message: "The job is no longer waiting on an answer." });

  const approval = await inbox.approveMerge(deps(), handId, id1, "h1");
  assert.deepEqual(approval, { ok: true, intentId: `panel:approve_merge:${id1}` });
  assert.deepEqual(await inbox.approveMerge(deps(), handId, id1, "h1"), approval, "a double submit records one intent");
  const [approveIntent] = await intentRows(HAND);
  assert.deepEqual([approveIntent!.kind, JSON.parse(approveIntent!.detail!)], ["approve_merge", { actor: OWNER, headSha: "h1" }]);
  assert.deepEqual(await inbox.intentOutcome(deps(), approveIntent!.id), { status: "pending" });

  // --- approve: the auto-merge path, blocked only by facts
  const approved = await approveMerge(handId, { actor: OWNER, headSha: "h1" });
  assert.deepEqual(approved, { merged: "merge-1" }, "the agent's handover, a protected path and the size limit do not block the owner");
  assert.deepEqual(putsTo(1).map((w) => [w.body.sha, w.body.merge_method]), [["h1", "squash"]], "one merge, pinned to the reviewed head");
  const merged1 = await row(HAND);
  assert.equal(merged1.stage, "merged", "the merge goes in as the usual stage event");
  assert.equal(merged1.merge_decision!.merged!.sha, "merge-1");
  assert.equal(merged1.merge_decision!.watch!.state, "watching", "and the post-merge watch starts");
  assert.equal(merged1.merge_decision!.approvedBy, OWNER);
  const audits = await db.select().from(auditLog).where(eq(auditLog.job_id, handId));
  assert.deepEqual(audits.map((a) => [a.action, a.actor]).sort(), [["merge_requested", OWNER], ["merge_succeeded", "factory"]]);
  assert.match(audits.find((a) => a.action === "merge_succeeded")!.detail!, /Approved in the inbox by owner@example\.com/);
  assert.deepEqual(await approveMerge(handId, { actor: OWNER, headSha: "h1" }), { merged: "merge-1" }, "a replay finds the merge recorded");
  assert.equal(putsTo(1).length, 1, "and never merges twice");
  await db.update(intents).set({ handled_at: new Date(), result: JSON.stringify({ approval: approved }) }).where(eq(intents.id, approveIntent!.id));
  assert.deepEqual(await inbox.intentOutcome(deps(), approveIntent!.id), { status: "done", message: "Merged as merge-1. The factory now watches main." });

  const RED = await job("RED", {}, { number: 2, checks: "failure", behind: 3 });
  assert.deepEqual(await approveMerge((await row(RED)).id, { actor: OWNER, headSha: null }), {
    blocked: "A check failed on the latest commit. The branch is 3 commits behind its base.",
  });
  assert.equal(putsTo(2).length, 0, "facts block before GitHub is asked to merge");
  const MOVED = await job("MOVED", {}, { number: 3 });
  assert.deepEqual(await approveMerge((await row(MOVED)).id, { actor: OWNER, headSha: "old" }), {
    refused: "The pull request moved to h3 since you reviewed old. Review the new commit first.",
  });
  assert.equal(putsTo(3).length, 0);
  const DENIED = await job("DENIED", {}, { number: 4, merge: { status: 403, body: { message: "Resource not accessible by integration" } } });
  assert.deepEqual(await approveMerge((await row(DENIED)).id, { actor: OWNER, headSha: "h4" }), {
    blocked: "The factory's GitHub App can't merge in this repo: Resource not accessible by integration",
  });
  assert.equal((await row(DENIED)).merge_decision!.blocked, "Resource not accessible by integration", "a refusal is recorded like auto-merge's");
  assert.equal((await row(DENIED)).stage, "pr");

  // --- request changes: wake, move back, send once
  const CHANGE = await job("CHANGE", { sandbox_snapshot: "im-snapshot" }, { number: 5 });
  const changeId = (await row(CHANGE)).id;
  const id2 = crypto.randomUUID();
  assert.deepEqual(await inbox.requestChanges(deps(), changeId, id2, "Use the existing hook."), { ok: true, intentId: `panel:request_changes:${id2}` });
  const [changeIntent] = await intentRows(CHANGE);
  const feedback = feedbackDetailSchema.parse(JSON.parse(changeIntent!.detail!));
  assert.deepEqual(feedback, { from: "panel", id: `panel:${id2}`, actor: OWNER, body: "Use the existing hook." });

  failSend = true;
  await assert.rejects(requestChanges(changeId, feedback), /t3 thread send failed/);
  assert.deepEqual((await row(CHANGE)).delivered_feedback_ids, [], "a failed send gives the claim back for the retry");
  assert.equal((await row(CHANGE)).stage, "pr");
  failSend = false;
  assert.deepEqual(await requestChanges(changeId, feedback), { sent: CHANGE, moved: true });
  assert.deepEqual(woken, [CHANGE, CHANGE], "a hibernated job is woken for it");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.thread, `thread-${CHANGE}`);
  assert.equal(sent[0]!.message, changesMessage({ prUrl: prUrl(5), feedback }), "framed for the thread");
  const changed = await row(CHANGE);
  assert.equal(changed.stage, "implementing", "the job goes back to implementing");
  assert.match(changed.stage_summary!, /owner@example\.com requested changes on/);
  assert.equal(inboxKind(changed), null, "and leaves the inbox");
  assert.deepEqual(await requestChanges(changeId, feedback), { skipped: "already sent" }, "a replayed intent sends nothing");
  assert.equal(sent.length, 1);
  assert.deepEqual(await inbox.requestChanges(deps(), changeId, crypto.randomUUID(), "More."), { ok: false, message: "The job is no longer waiting on your review." });

  const GONE = await job("GONE", {}, { number: 6 });
  threadState = "gone";
  assert.match(JSON.stringify(await requestChanges((await row(GONE)).id, { ...feedback, id: "panel:gone" })), /thread is gone/);
  assert.deepEqual((await row(GONE)).delivered_feedback_ids, [], "nothing is claimed for a gone thread");
  threadState = "stopped";

  // --- GitHub reviews: recorded once per review, forwarded like the panel's
  const { default: ingestFunction } = await import("../functions/ingest/index");
  const REVIEWED = await job("REVIEWED", {}, { number: 7 });
  const reviewBody = (delivery: string, user = { login: "jan", type: "User" }) => {
    const raw = JSON.stringify({ ...review({ id: 9000 + stamp }, user), pull_request: { html_url: prUrl(7) } });
    return new Request("http://function/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "pull_request_review", "x-github-delivery": delivery, "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}` },
      body: raw,
    });
  };
  const deliveries = [`inbox-regress-${stamp}-1`, `inbox-regress-${stamp}-2`, `inbox-regress-${stamp}-bot`];
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[0]!))).json(), { duplicate: false, intent: "request_changes" });
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[1]!))).json(), { duplicate: false, intent: "request_changes" }, "a second delivery of the review");
  assert.deepEqual(await (await ingestFunction.fetch(reviewBody(deliveries[2]!, { login: "cursor[bot]", type: "Bot" }))).json(), { duplicate: false, intent: null });
  const reviewIntents = await intentRows(REVIEWED);
  assert.deepEqual(reviewIntents.map((i) => i.id), [`github:review:${9000 + stamp}`], "one intent per review id, tied to the job by its PR");
  const reviewFeedback = feedbackDetailSchema.parse(JSON.parse(reviewIntents[0]!.detail!));
  assert.deepEqual(await requestChanges(reviewIntents[0]!.job_id, reviewFeedback), { sent: REVIEWED, moved: true });
  assert.match(sent.at(-1)!.message, /^The reviewer \(@jan on GitHub\) requested changes on .*pull\/7:\n\n> Rename the helper\.\n\nComments on the code:\n\n- src\/a\.ts:12\n  > This name is unclear\./);
  assert.deepEqual(await requestChanges(reviewIntents[0]!.job_id, reviewFeedback), { skipped: "already sent" });
  assert.deepEqual(await requestChanges(null, reviewFeedback), { skipped: "the pull request is not a factory job's" }, "a review on another PR is ignored");
  const before = sent.length;
  const later = { ...reviewFeedback, id: "review:later", reviewId: 1 };
  assert.deepEqual(await requestChanges(reviewIntents[0]!.job_id, later), { sent: REVIEWED, moved: false }, "a thread already at work only hears it");
  assert.equal(sent.length, before + 1);

  // --- answer: the owner's reply in the source, then the usual resume
  const ASKED = await job("ASKED", { stage: "waiting", question: "Which list?" });
  const id3 = crypto.randomUUID();
  assert.deepEqual(await inbox.answerQuestion(deps(), (await row(ASKED)).id, id3, " The sidebar one. "), { ok: true, intentId: `panel:answer:${id3}` });
  assert.deepEqual(replies, [{ key: ASKED, requestId: id3, body: "The sidebar one." }]);
  assert.equal((await intentRows(ASKED))[0]!.kind, "answer", "the runner's answer intent resumes it");

  // --- close and dismiss
  const CLOSE = await job("CLOSE", {}, { number: 8 });
  const closeId = (await row(CLOSE)).id;
  assert.deepEqual(await closeJob(closeId, { actor: OWNER, reason: "Not needed" }), { closed: CLOSE, pr: "closed" });
  assert.deepEqual(writes.filter((w) => w.method === "PATCH" && w.path === `/repos/${REPO}/pulls/8`).map((w) => w.body), [{ state: "closed" }]);
  const closed = await row(CLOSE);
  assert.deepEqual([closed.stage, closed.stage_summary], ["failed", "Closed in the inbox by owner@example.com: Not needed."]);
  assert.ok(closed.stop_event_id, "the thread is told to stop, as for a stop");
  assert.equal(closed.stop_sent_to, `thread-${CLOSE}`);
  assert.match(sent.at(-1)!.message, /^Stop working on INBCLOSE/);
  assert.equal(inboxKind(closed), null, "a closed job does not come back as a failure");
  assert.deepEqual(await closeJob(closeId, { actor: OWNER, reason: "" }), { closed: CLOSE, pr: "already closed" }, "a replay closes nothing twice");

  const FAILED = await job("FAILED", { stage: "failed", stage_summary: "Watchdog stopped this run." });
  const failedId = (await row(FAILED)).id;
  assert.equal(inboxKind(await row(FAILED)), "failed");
  assert.deepEqual(await inbox.dismissJob(deps(), failedId), { ok: true, intentId: null });
  const dismissed = await row(FAILED);
  assert.deepEqual([dismissed.stage, inboxKind(dismissed)], ["failed", null], "dismiss only hides it");
  assert.deepEqual(await inbox.dismissJob(deps(), failedId), { ok: false, message: "Only a failed job can be dismissed." });

  console.log("inbox regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  const ids = (await db.select({ id: jobs.id }).from(jobs).where(like(jobs.id, `${jobId("linear", "inbox-regress-")}%`))).map((j) => j.id);
  if (ids.length > 0) {
    await db.delete(auditLog).where(inArray(auditLog.job_id, ids));
    await db.delete(intents).where(inArray(intents.job_id, ids));
  }
  await db.delete(webhookDeliveries).where(like(webhookDeliveries.delivery_id, `github:inbox-regress-${stamp}-%`));
  if (keys.length > 0) await db.delete(events).where(inArray(events.job_key, keys));
  await db.delete(jobs).where(like(jobs.id, `${jobId("linear", "inbox-regress-")}%`));
  await db.delete(repoSettings).where(eq(repoSettings.repo, REPO));
  await server.close();
  process.exit(process.exitCode ?? 0);
}
