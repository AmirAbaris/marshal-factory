import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { jobs } from "../db/schema";
import type { JobId } from "./sources/shapes";

export function qaBlock(question: string, answer: string) {
  const quote = (text: string) => text.trim().replace(/^/gm, "> ");
  return ["## Your question", "", quote(question), "", "## Answer", "", quote(answer)].join("\n");
}

/** The turn a resumed thread receives. */
export function resumeMessage(subject: string, question: string, answer: string) {
  return [
    `The reporter answered your question on ${subject}.`,
    "",
    "Continue the factory playbook (.agents/playbooks/factory.md) from Triage, on this same branch, treating the answer as the spec. Report every stage with the report_stage tool. If the answer is still not enough to write an acceptance check, report waiting with one more concrete question instead of guessing.",
    "",
    qaBlock(question, answer),
  ].join("\n");
}

/**
 * Marks replies delivered while the job is still waiting. Returns false when another pass
 * already delivered any of them, which is the replay guard: claim first, then send. Only a
 * failed send rolls the claim back; after a successful send the thread's own reports move on.
 */
export async function claimReplies(
  db: NodePgDatabase<typeof schema>,
  id: JobId,
  replyIds: readonly string[],
  answer: string,
  at: Date,
  /** Set when the thread that asked is gone: unlinks it and keeps the Q&A for a fresh thread. */
  relaunchContext?: string,
) {
  const claimed = await db
    .update(jobs)
    .set({
      delivered_reply_ids: sql`${jobs.delivered_reply_ids} || ${JSON.stringify(replyIds)}::jsonb`,
      answered_at: at,
      answer,
      updated_at: at,
      ...(relaunchContext
        ? { resume_context: relaunchContext, t3_thread_id: null, session_id: null, machine_id: null }
        : {}),
    })
    .where(
      and(
        eq(jobs.id, id),
        eq(jobs.stage, "waiting"),
        sql`not (${jobs.delivered_reply_ids} ?| array[${sql.join(
          replyIds.map((r) => sql`${r}`),
          sql`, `,
        )}]::text[])`,
      ),
    )
    .returning({ key: jobs.key });
  return claimed.length > 0;
}
