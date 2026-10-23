import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { issues, type IssueRow } from "../db/schema";
import { commentId, type LinearComment } from "./linear";

/** Linear state types that end an issue; a waiting run on one of them never resumes. */
const CLOSED_STATE_TYPES = new Set(["completed", "canceled", "duplicate"]);

export type ResumePlan =
  | { kind: "wait" }
  | { kind: "close"; state: string }
  | { kind: "resume"; question: string; replies: LinearComment[]; answer: string };

type WaitingIssue = Pick<
  IssueRow,
  "linear_id" | "stage_event_id" | "question" | "factory_comment_ids" | "delivered_reply_ids"
>;

export const claimCommentId = (linearId: string, attempt = 1) =>
  attempt > 1 ? commentId(linearId, "claim", String(attempt)) : commentId(linearId, "claim");
export const stageCommentId = (linearId: string, stageEventId: string) =>
  commentId(linearId, stageEventId);
export const resumeCommentId = (linearId: string, replyIds: readonly string[]) =>
  commentId(linearId, "resume", ...replyIds);

/**
 * Decides what a waiting issue needs from what Linear shows. Replies are the comments after the
 * question comment that the factory did not post and no earlier resume delivered. The API key is
 * the operator's own, so authorship cannot tell them apart; the stored comment ids do.
 */
export function planResume(
  issue: WaitingIssue,
  linear: { state: { name: string; type: string }; comments: readonly LinearComment[] },
): ResumePlan {
  if (CLOSED_STATE_TYPES.has(linear.state.type)) return { kind: "close", state: linear.state.name };
  if (!issue.stage_event_id) return { kind: "wait" };

  const questionId = stageCommentId(issue.linear_id, issue.stage_event_id);
  const asked = linear.comments.find((c) => c.id === questionId);
  if (!asked) return { kind: "wait" };

  const ours = new Set([
    ...issue.factory_comment_ids,
    claimCommentId(issue.linear_id),
    questionId,
  ]);
  const delivered = new Set(issue.delivered_reply_ids);
  const replies = linear.comments
    .filter((c) => c.createdAt > asked.createdAt && !ours.has(c.id) && !delivered.has(c.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (replies.length === 0) return { kind: "wait" };

  return {
    kind: "resume",
    question: issue.question ?? asked.body,
    replies,
    answer: replies.map((r) => r.body.trim()).join("\n\n"),
  };
}

export function qaBlock(question: string, answer: string) {
  const quote = (text: string) => text.trim().replace(/^/gm, "> ");
  return ["## Your question", "", quote(question), "", "## Answer", "", quote(answer)].join("\n");
}

/** The turn a resumed thread receives. */
export function resumeMessage(key: string, question: string, answer: string) {
  return [
    `The reporter answered your question on Linear issue ${key}.`,
    "",
    "Continue the factory playbook (.agents/playbooks/factory.md) from Triage, on this same branch, treating the answer as the spec. Report every stage with the report_stage tool. If the answer is still not enough to write an acceptance check, report waiting with one more concrete question instead of guessing.",
    "",
    qaBlock(question, answer),
  ].join("\n");
}

/**
 * Marks replies delivered while the issue is still waiting. Returns false when another pass
 * already delivered any of them, which is the replay guard: claim first, then send. Only a
 * failed send rolls the claim back; after a successful send the thread's own reports move on.
 */
export async function claimReplies(
  db: NodePgDatabase<typeof schema>,
  linearId: string,
  replyIds: readonly string[],
  answer: string,
  at: Date,
  /** Set when the thread that asked is gone: unlinks it and keeps the Q&A for a fresh thread. */
  relaunchContext?: string,
) {
  const claimed = await db
    .update(issues)
    .set({
      delivered_reply_ids: sql`${issues.delivered_reply_ids} || ${JSON.stringify(replyIds)}::jsonb`,
      answered_at: at,
      answer,
      updated_at: at,
      ...(relaunchContext
        ? { resume_context: relaunchContext, t3_thread_id: null, session_id: null }
        : {}),
    })
    .where(
      and(
        eq(issues.linear_id, linearId),
        eq(issues.stage, "waiting"),
        sql`not (${issues.delivered_reply_ids} ?| array[${sql.join(
          replyIds.map((r) => sql`${r}`),
          sql`, `,
        )}]::text[])`,
      ),
    )
    .returning({ key: issues.key });
  return claimed.length > 0;
}
