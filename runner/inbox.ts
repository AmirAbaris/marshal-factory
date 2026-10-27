import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs } from "../db/schema";
import { github } from "../lib/github/pulls";
import { ensureAwake } from "../lib/host";
import { changesMessage, type CloseDetail, type FeedbackDetail, type ReviewComment } from "../lib/inbox";
import { mergeDecisionSchema } from "../lib/merge-decision";
import { parseJob } from "../lib/sources";
import type { Job, JobId } from "../lib/sources/types";
import { canTransition, runnerEventId } from "../lib/stages";
import { finishStop, IN_FLIGHT, postEvent, threads } from "./ops";

// The inbox's actions on the job's own machine. Requested changes reach the thread once per
// feedback id: the id is claimed on the job before the send and given back if the send fails, as
// resumes do with reply ids. A close closes the PR and fails the job the way a stop does.

export type ChangesResult = { sent: string; moved: boolean } | { skipped: string } | { refused: string };

const readJob = async (id: JobId) => {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ? parseJob(row) : null;
};

/** Where the feedback goes: a PR goes back to implementing, a thread already at work only hears it. */
function changesMode(job: Job): "move" | "send" | "revert" | null {
  if (job.stage === "pr") return "move";
  if (IN_FLIGHT.includes(job.stage)) return "send";
  const decision = mergeDecisionSchema.safeParse(job.merge_decision).data;
  if (job.stage === "merged" && decision?.watch?.state === "revert_failed") return "revert";
  return null;
}

export async function requestChanges(id: JobId | null, feedback: FeedbackDetail): Promise<ChangesResult> {
  if (!id) return { skipped: "the pull request is not a factory job's" };
  const job = await readJob(id);
  if (!job?.pr_url) return { skipped: "the job has no pull request" };
  if (job.delivered_feedback_ids.includes(feedback.id)) return { skipped: "already sent" };
  const mode = changesMode(job);
  if (!mode) return { refused: `The job is in ${job.stage}, so there is no work to change.` };
  const comments: ReviewComment[] = feedback.from === "github" ? await github.reviewComments(job.pr_url, feedback.reviewId) : [];
  if (!feedback.body.trim() && comments.length === 0) return { skipped: "the review has no text" };

  const host = await ensureAwake(job);
  if ((await threads.state(job.t3_thread_id, host)) === "gone") {
    return { refused: "The job's thread is gone, so it can't take the feedback. Close the job, or retry the issue as a new attempt." };
  }
  const claimed = await db
    .update(jobs)
    .set({ delivered_feedback_ids: sql`${jobs.delivered_feedback_ids} || ${JSON.stringify([feedback.id])}::jsonb`, updated_at: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.stage, job.stage), sql`not (${jobs.delivered_feedback_ids} ? ${feedback.id})`))
    .returning({ key: jobs.key });
  if (claimed.length === 0) return { skipped: "already sent, or the job moved on" };
  try {
    await threads.send(job.t3_thread_id!, changesMessage({ prUrl: job.pr_url, feedback, comments, revertFailed: mode === "revert" }), host);
  } catch (error) {
    await db
      .update(jobs)
      .set({ delivered_feedback_ids: sql`${jobs.delivered_feedback_ids} - ${feedback.id}` })
      .where(eq(jobs.id, job.id));
    throw error;
  }
  if (mode !== "move") return { sent: job.key, moved: false };
  // The thread has the feedback now; if this event fails, its own reports still move the board.
  const who = feedback.from === "github" ? `@${feedback.reviewer} on GitHub` : feedback.actor;
  await postEvent({
    eventId: runnerEventId("changes", job.external_id, feedback.id),
    sessionId: job.session_id ?? runnerEventId("changes", job.external_id),
    at: Date.now(),
    kind: "stage",
    stage: "implementing",
    summary: `${who} requested changes on ${job.pr_url}; the thread is updating it.`,
    jobKey: job.key,
  });
  return { sent: job.key, moved: true };
}

export type CloseResult = { closed: string; pr: "closed" | "already closed" | "none" } | { refused: string };

/**
 * Closes the job's PR if it is open and fails the job with the owner's reason, telling its thread
 * to stop. The failure is written back to the source like any other, and the inbox leaves it out.
 */
export async function closeJob(id: JobId, { actor, reason }: CloseDetail, now = new Date()): Promise<CloseResult> {
  for (let tries = 0; tries < 3; tries++) {
    const job = await readJob(id);
    if (!job) return { refused: `No job ${id}.` };
    const failing = canTransition(job.stage, "failed", "stop");
    if (!failing && job.stage !== "failed") return { refused: `The job is ${job.stage}; there is nothing to close.` };
    let pr: Extract<CloseResult, { closed: string }>["pr"] = "none";
    if (job.pr_url) {
      const pull = await github.pullRequest(job.pr_url);
      if (pull.state === "open") await github.closePull(job.pr_url);
      pr = pull.state === "open" ? "closed" : "already closed";
    }
    if (!failing) {
      await db.update(jobs).set({ dismissed_at: now }).where(eq(jobs.id, job.id));
      return { closed: job.key, pr };
    }
    const eventId = runnerEventId("stop", job.external_id, job.attempt, "closed", job.stage_event_id ?? job.stage);
    const summary = `Closed in the inbox by ${actor}${reason.trim() ? `: ${reason.trim()}` : ""}.`;
    const [stopped] = await db
      .update(jobs)
      .set({ stage: "failed", stage_at: now, stage_summary: summary, question: null, stage_event_id: eventId, stop_event_id: eventId, dismissed_at: now, updated_at: now })
      .where(and(eq(jobs.id, id), eq(jobs.stage, job.stage), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning();
    if (!stopped) continue;
    await finishStop(parseJob(stopped), false);
    return { closed: job.key, pr };
  }
  throw new Error("the stage kept changing; the close is retried");
}
