import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, intents, jobs, type IntentRow } from "../db/schema";
import { attemptBranch, parseBranch } from "../lib/factory";
import { github } from "../lib/github/pulls";
import { ensureAwake } from "../lib/host";
import { changesMessage, type CloseDetail, type FeedbackDetail, type RetryDetail, type ReviewComment } from "../lib/inbox";
import { parseJob, sourceFor } from "../lib/sources";
import type { Job, JobId } from "../lib/sources/types";
import { canTransition, runnerEventId } from "../lib/stages";
import { requestedStop } from "../lib/stop";
import { claim, finishStop, IN_FLIGHT, postEvent, threads } from "./ops";

// The inbox's actions on the job's own machine. Requested changes reach the thread once per
// feedback id: the id is claimed on the job before the send and given back if the send fails, as
// resumes do with reply ids. A close closes the PR and fails the job the way a stop does.
// A person's GitHub review can arrive before its job can take it; it waits, see forwardReview.

export type ChangesResult = { sent: string; moved: boolean } | { skipped: string } | { refused: string };
/** Feedback the job cannot take yet but may later: its intent stays open and is tried again. */
type Waiting = { waiting: string };

/** How long a person's GitHub review waits for its job to be able to take it. */
export const REVIEW_WAIT_MS = 24 * 3_600_000;

const readJob = async (id: JobId) => {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ? parseJob(row) : null;
};

/** Where the feedback goes: a PR goes back to implementing, a thread already at work only hears it. */
function changesMode(job: Job): "move" | "send" | null {
  if (job.stage === "pr") return "move";
  if (IN_FLIGHT.includes(job.stage)) return "send";
  return null;
}

async function deliver(job: Job, feedback: FeedbackDetail): Promise<ChangesResult | Waiting> {
  if (job.delivered_feedback_ids.includes(feedback.id)) return { skipped: "already sent" };
  if (job.stage === "merged" || job.stage === "failed") return { refused: `The job is ${job.stage}, so there is no work to change.` };
  if (!job.pr_url) return { waiting: "the job has no pull request yet" };
  const mode = changesMode(job);
  if (!mode) return { waiting: `the job is ${job.stage}` };
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
    await threads.send(job.t3_thread_id!, changesMessage({ prUrl: job.pr_url, feedback, comments }), host);
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

/** The owner's feedback from the panel, which only offers it on a PR waiting for review. */
export async function requestChanges(id: JobId | null, feedback: FeedbackDetail): Promise<ChangesResult> {
  if (!id) return { skipped: "the pull request is not a factory job's" };
  const job = await readJob(id);
  if (!job) return { skipped: "the pull request is not a factory job's" };
  const result = await deliver(job, feedback);
  return "waiting" in result ? { refused: `The job can't take feedback yet: ${result.waiting}.` } : result;
}

type GithubFeedback = Extract<FeedbackDetail, { from: "github" }>;
type ReviewIntent = Pick<IntentRow, "id" | "job_id" | "pr_url" | "created_at">;

/** The job a review is about: by the intent's job, else its PR, else the attempt branch it was left on. */
async function reviewedJob(intent: ReviewIntent, feedback: GithubFeedback) {
  const byId = intent.job_id ? await readJob(intent.job_id) : null;
  const [byPr] = !byId && intent.pr_url ? await db.select().from(jobs).where(eq(jobs.pr_url, intent.pr_url)) : [];
  const key = parseBranch(feedback.branch)?.key;
  const [byBranch] = !byId && !byPr && key ? await db.select().from(jobs).where(eq(jobs.key, key)) : [];
  const row = byPr ?? byBranch;
  const job = byId ?? (row ? parseJob(row) : null);
  if (!job) return null;
  // A review on an earlier attempt's PR is not for the attempt at work now.
  if (job.pr_url ? job.pr_url !== intent.pr_url : feedback.branch !== undefined && feedback.branch !== attemptBranch(job.key, job.attempt)) return null;
  return job;
}

/**
 * Forwards a person's GitHub review. Reviews keep coming once a PR is up, so one can land before
 * its job records the PR, while it waits on a question, or while its sandbox fails to wake; those
 * leave the intent open (the result is a waiting reason) and every retry looks the job up again.
 * A finished job, a review already sent or one that is no factory job's closes it. After
 * REVIEW_WAIT_MS of waiting the review is dropped with an audit row.
 */
export async function forwardReview(intent: ReviewIntent, feedback: GithubFeedback, machineId: string, now = Date.now()): Promise<ChangesResult | Waiting> {
  const job = await reviewedJob(intent, feedback);
  if (!job) return { skipped: "the pull request is not a factory job's" };
  // Owner routing sends the retry to the job's machine, the only one that reaches its thread.
  if (intent.job_id !== job.id) await db.update(intents).set({ job_id: job.id }).where(eq(intents.id, intent.id));
  const result: ChangesResult | Waiting =
    job.machine_id && job.machine_id !== machineId
      ? { waiting: "the job runs on another machine" }
      : await deliver(job, feedback).catch((error: unknown) => ({ waiting: error instanceof Error ? error.message : String(error) }));
  if (!("waiting" in result) || now - intent.created_at.getTime() < REVIEW_WAIT_MS) return result;
  const detail = `@${feedback.reviewer}'s review never reached the agent: after 24 hours ${result.waiting}.`;
  await db
    .insert(auditLog)
    .values({
      id: `${intent.id}:dropped`,
      at: new Date(now),
      actor: `@${feedback.reviewer} on GitHub`,
      action: "review_dropped",
      job_id: job.id,
      target: intent.pr_url ?? job.pr_url ?? job.url,
      head_sha: "",
      result: "refused",
      detail: detail.slice(0, 2000),
    })
    .onConflictDoNothing();
  return { refused: detail };
}

export type CloseResult = { closed: string; pr: "closed" | "already closed" | "none" } | { refused: string };

/**
 * Closes the job's PR if it is open and fails the job with the owner's reason, telling its thread
 * to stop. The failure is written back to the source like any other once the stop settles, and
 * the inbox leaves it out unless the stop can't be confirmed.
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
      .set({
        stage: "failed",
        stage_at: now,
        stage_summary: summary,
        question: null,
        stage_event_id: eventId,
        stop_event_id: eventId,
        stop: requestedStop({ at: now, by: actor, reason: summary, reopen: false }),
        dismissed_at: now,
        updated_at: now,
      })
      .where(and(eq(jobs.id, id), eq(jobs.stage, job.stage), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning();
    if (!stopped) continue;
    await finishStop(parseJob(stopped));
    return { closed: job.key, pr };
  }
  throw new Error("the stage kept changing; the close is retried");
}

export type RetryResult = { started: number } | { refused: string };

/**
 * Starts the next attempt of a failed job the way the label does: the source shows the issue as
 * ready again and the usual claim bumps the attempt. The note is stored under the attempt it is
 * for before anything else, and the source's comment is keyed by attempt, so a replay repeats
 * nothing. A replay after the new attempt exists finds it and says so.
 */
export async function retryJob(id: JobId, { actor, attempt, note }: RetryDetail, claimReady: () => Promise<unknown> = claim): Promise<RetryResult> {
  const job = await readJob(id);
  if (!job) return { refused: `No job ${id}.` };
  if (job.attempt > attempt) return { started: job.attempt };
  if (job.stage !== "failed") return { refused: `The job is ${job.stage}, not failed; there is nothing to retry.` };
  const next = job.attempt + 1;
  const text = note.trim();
  if (text) {
    await db
      .update(jobs)
      .set({ attempt_note: { attempt: next, text }, updated_at: new Date() })
      .where(and(eq(jobs.id, job.id), eq(jobs.stage, "failed"), eq(jobs.attempt, job.attempt)));
  }
  const source = sourceFor(job.source);
  await source.requeue(job);
  if (text) await source.note(job, `retry-${next}`, `**Note from ${actor} for attempt ${next}**\n\n${text}`);
  await claimReady();
  const after = await readJob(id);
  if (after && after.attempt > job.attempt) return { started: after.attempt };
  return { refused: "The factory can't start another attempt yet, for example while the failed one is still stopping. The factory label is back on the issue, so the next attempt starts as soon as it can." };
}
