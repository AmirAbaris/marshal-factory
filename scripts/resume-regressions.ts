import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { issues } = await import("../db/schema");
const { claimReplies, planResume, resumeCommentId, stageCommentId, claimCommentId } = await import(
  "../lib/resume"
);

const id = `resume-regress-${Date.now()}`;
const stageEventId = "evt-waiting";
const question = { id: stageCommentId(id, stageEventId), body: "Which layout?", createdAt: "2026-10-23T10:00:00.000Z" };
const claim = { id: claimCommentId(id), body: "Picked up", createdAt: "2026-10-23T09:00:00.000Z" };
const early = { id: "c-early", body: "a note before the question", createdAt: "2026-10-23T09:30:00.000Z" };
const reply1 = { id: "c-1", body: "1: (b)", createdAt: "2026-10-23T10:05:00.000Z" };
const reply2 = { id: "c-2", body: "2: (b)", createdAt: "2026-10-23T10:06:00.000Z" };
const issue = {
  linear_id: id,
  stage_event_id: stageEventId,
  question: "Which layout?",
  factory_comment_ids: [claim.id, question.id],
  delivered_reply_ids: [] as string[],
};
const open = { name: "In Progress", type: "started" };

assert.deepEqual(
  planResume(issue, { state: open, comments: [claim, early] }),
  { kind: "wait" },
  "no question comment yet means wait",
);
assert.deepEqual(planResume(issue, { state: open, comments: [claim, early, question] }), { kind: "wait" });

const both = planResume(issue, { state: open, comments: [reply2, question, claim, reply1, early] });
assert.equal(both.kind, "resume");
assert.deepEqual(both.kind === "resume" && both.replies.map((r) => r.id), ["c-1", "c-2"], "replies come together, oldest first");
assert.equal(both.kind === "resume" && both.answer, "1: (b)\n\n2: (b)");

const ack = { id: resumeCommentId(id, ["c-1", "c-2"]), body: "Answer received, resuming.", createdAt: "2026-10-23T10:07:00.000Z" };
assert.deepEqual(
  planResume(
    { ...issue, factory_comment_ids: [...issue.factory_comment_ids, ack.id], delivered_reply_ids: ["c-1", "c-2"] },
    { state: open, comments: [question, reply1, reply2, ack] },
  ),
  { kind: "wait" },
  "delivered replies and the factory's own ack are not new replies",
);
assert.deepEqual(
  planResume(issue, { state: { name: "Canceled", type: "canceled" }, comments: [question, reply1] }),
  { kind: "close", state: "Canceled" },
  "an issue closed in Linear never resumes",
);

const now = new Date();
await db.insert(issues).values({
  linear_id: id,
  key: id,
  title: "resume regression",
  url: "https://linear.app/x",
  stage: "waiting",
  claimed_at: now,
  updated_at: now,
});
try {
  assert.equal(await claimReplies(db, id, ["c-1", "c-2"], "a", now), true, "the first pass claims the replies");
  assert.equal(await claimReplies(db, id, ["c-1", "c-2"], "a", now), false, "a replayed pass claims nothing");
  assert.equal(await claimReplies(db, id, ["c-2", "c-3"], "b", now), false, "any already delivered reply blocks the claim");
  const [row] = await db.select().from(issues).where(eq(issues.linear_id, id));
  assert.deepEqual(row!.delivered_reply_ids, ["c-1", "c-2"]);

  await db.update(issues).set({ t3_thread_id: "dead-thread", session_id: "old-session" }).where(eq(issues.linear_id, id));
  assert.equal(await claimReplies(db, id, ["c-3"], "c", now, "## Q&A"), true);
  const [relaunch] = await db.select().from(issues).where(eq(issues.linear_id, id));
  assert.equal(relaunch!.t3_thread_id, null, "claiming for a dead thread unlinks it in the same update");
  assert.equal(relaunch!.session_id, null);
  assert.equal(relaunch!.resume_context, "## Q&A");
  console.log("resume regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(issues).where(eq(issues.linear_id, id));
  process.exit(process.exitCode ?? 0);
}
