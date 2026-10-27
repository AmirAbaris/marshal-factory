import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "@/db/schema";
import { intents, jobs, type IntentKind, type JobRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { RepoName } from "@/lib/github/app";
import type { PullsClient } from "@/lib/github/pulls";
import {
  allows,
  inboxKind,
  MAX_FEEDBACK_CHARS,
  type ApproveDetail,
  type CloseDetail,
  type FeedbackDetail,
  type InboxAction,
} from "@/lib/inbox";
import { mergeDecisionSchema, reviewSummary, type ReviewSummary } from "@/lib/merge-decision";
import { parseJob } from "@/lib/sources";
import type { Job, JobId } from "@/lib/sources/types";

// The inbox's owner-only actions. Each one checks the owner and that the job still offers the
// action, then records an intent for the job's runner; only dismiss and the answer's comment act
// at once. A request id from the browser keys each intent, so a double submit records it once.
// The browser asks for the intent's outcome until the runner has handled it.

export type InboxDeps = {
  db: NodePgDatabase<typeof schema>;
  user: () => Promise<SessionUser | null | undefined>;
  /** Posts the owner's answer in the job's source; see SourceAdapter.reply. */
  reply: (job: Job, requestId: string, body: string) => Promise<void>;
  now?: () => Date;
};

export type InboxOutcome = { ok: true; intentId: string | null } | { ok: false; message: string };

const OWNER_ONLY = "Only the factory owner can act on the inbox.";
const requestIdSchema = z.uuid();

const NOT_OFFERED: Record<InboxAction, string> = {
  answer: "The job is no longer waiting on an answer.",
  approve: "The pull request is no longer waiting on your review.",
  request_changes: "The job is no longer waiting on your review.",
  close: "The job is no longer waiting on you.",
  dismiss: "Only a failed job can be dismissed.",
};

async function ownerJob(deps: InboxDeps, jobId: JobId, action: InboxAction) {
  const user = await deps.user();
  if (!isOwner(user)) return { ok: false, message: OWNER_ONLY } as const;
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { ok: false, message: `No job ${jobId}.` } as const;
  if (!allows(inboxKind(job), action)) return { ok: false, message: NOT_OFFERED[action] } as const;
  return { ok: true, actor: user!.email, job } as const;
}

async function record(deps: InboxDeps, job: JobRow, kind: IntentKind, requestId: string, detail: object): Promise<InboxOutcome> {
  const id = `panel:${kind}:${requestId}`;
  await deps.db
    .insert(intents)
    .values({ id, kind, job_id: job.id, pr_url: job.pr_url, detail: JSON.stringify(detail), created_at: (deps.now ?? (() => new Date()))() })
    .onConflictDoNothing();
  return { ok: true, intentId: id };
}

const badRequest = (requestId: string) => !requestIdSchema.safeParse(requestId).success;

/** Asks the runner to merge the PR at the head the owner reviewed; null merges whatever head it has. */
export async function approveMerge(deps: InboxDeps, jobId: JobId, requestId: string, headSha: string | null): Promise<InboxOutcome> {
  if (badRequest(requestId)) return { ok: false, message: "The request is not valid." };
  const found = await ownerJob(deps, jobId, "approve");
  if (!found.ok) return found;
  return record(deps, found.job, "approve_merge", requestId, { actor: found.actor, headSha } satisfies ApproveDetail);
}

const feedbackSchema = z.string().trim().min(1, "Write what should change.").max(MAX_FEEDBACK_CHARS, "The feedback is too long.");

/** Sends the owner's feedback to the job's thread, which goes back to work on the same PR. */
export async function requestChanges(deps: InboxDeps, jobId: JobId, requestId: string, body: string): Promise<InboxOutcome> {
  if (badRequest(requestId)) return { ok: false, message: "The request is not valid." };
  const text = feedbackSchema.safeParse(body);
  if (!text.success) return { ok: false, message: text.error.issues[0]!.message };
  const found = await ownerJob(deps, jobId, "request_changes");
  if (!found.ok) return found;
  const detail: FeedbackDetail = { from: "panel", id: `panel:${requestId}`, actor: found.actor, body: text.data };
  return record(deps, found.job, "request_changes", requestId, detail);
}

/** Answers the job's question in its source as a reply, then asks its runner to resume it. */
export async function answerQuestion(deps: InboxDeps, jobId: JobId, requestId: string, body: string): Promise<InboxOutcome> {
  if (badRequest(requestId)) return { ok: false, message: "The request is not valid." };
  const text = feedbackSchema.safeParse(body);
  if (!text.success) return { ok: false, message: "Write an answer." };
  const found = await ownerJob(deps, jobId, "answer");
  if (!found.ok) return found;
  try {
    await deps.reply(parseJob(found.job), requestId, text.data);
  } catch (error) {
    return { ok: false, message: `Could not post the answer: ${error instanceof Error ? error.message : String(error)}` };
  }
  return record(deps, found.job, "answer", requestId, {});
}

/** Closes the job's PR and fails the job with the owner's reason. */
export async function closeJob(deps: InboxDeps, jobId: JobId, requestId: string, reason: string): Promise<InboxOutcome> {
  if (badRequest(requestId)) return { ok: false, message: "The request is not valid." };
  if (reason.length > 2000) return { ok: false, message: "The reason is too long." };
  const found = await ownerJob(deps, jobId, "close");
  if (!found.ok) return found;
  return record(deps, found.job, "close_job", requestId, { actor: found.actor, reason: reason.trim() } satisfies CloseDetail);
}

/** Hides a failed job from the inbox and changes nothing else; a later failure shows again. */
export async function dismissJob(deps: InboxDeps, jobId: JobId): Promise<InboxOutcome> {
  const found = await ownerJob(deps, jobId, "dismiss");
  if (!found.ok) return found;
  await deps.db.update(jobs).set({ dismissed_at: (deps.now ?? (() => new Date()))() }).where(eq(jobs.id, found.job.id));
  return { ok: true, intentId: null };
}

export type IntentOutcome = { status: "pending" } | { status: "done"; message: string } | { status: "failed"; message: string };

const INBOX_INTENTS = ["approve_merge", "request_changes", "close_job", "answer"] as const satisfies readonly IntentKind[];

const resultSchema = z.object({
  error: z.string().optional(),
  approval: z.union([z.object({ merged: z.string() }), z.object({ blocked: z.string() }), z.object({ refused: z.string() })]).optional(),
  changes: z.union([z.object({ sent: z.string(), moved: z.boolean() }), z.object({ skipped: z.string() }), z.object({ refused: z.string() })]).optional(),
  close: z.union([z.object({ closed: z.string(), pr: z.string() }), z.object({ refused: z.string() })]).optional(),
});

/** What the runner made of an intent: the result it stored, said for the owner. */
export function describeOutcome(kind: (typeof INBOX_INTENTS)[number], raw: string | null): IntentOutcome {
  const result = resultSchema.safeParse(raw ? JSON.parse(raw) : {}).data;
  if (!result) return { status: "failed", message: "The runner's answer could not be read." };
  if (result.error) return { status: "failed", message: `The runner could not do it: ${result.error}` };
  switch (kind) {
    case "approve_merge": {
      const a = result.approval;
      if (!a) break;
      if ("merged" in a) return { status: "done", message: `Merged as ${a.merged.slice(0, 7)}. The factory now watches main.` };
      return { status: "failed", message: "blocked" in a ? `Not merged: ${a.blocked}` : a.refused };
    }
    case "request_changes": {
      const c = result.changes;
      if (!c) break;
      if ("sent" in c) return { status: "done", message: c.moved ? "Sent to the agent. The job is back in implementing." : "Sent to the agent." };
      return "refused" in c ? { status: "failed", message: c.refused } : { status: "done", message: `Nothing sent: ${c.skipped}.` };
    }
    case "close_job": {
      const c = result.close;
      if (!c) break;
      return "closed" in c ? { status: "done", message: c.pr === "closed" ? "Closed the pull request and the job." : "Closed the job." } : { status: "failed", message: c.refused };
    }
    case "answer":
      return { status: "done", message: "Answer sent. The job resumes." };
    default: {
      const never: never = kind;
      throw new Error(`unknown inbox intent ${String(never)}`);
    }
  }
  return { status: "failed", message: "The runner's answer could not be read." };
}

export async function intentOutcome(deps: Pick<InboxDeps, "db" | "user">, intentId: string): Promise<IntentOutcome> {
  if (!isOwner(await deps.user())) return { status: "failed", message: OWNER_ONLY };
  const [intent] = await deps.db
    .select()
    .from(intents)
    .where(and(eq(intents.id, intentId), inArray(intents.kind, [...INBOX_INTENTS])));
  if (!intent || !intent.id.startsWith("panel:")) return { status: "failed", message: "No such request." };
  if (!intent.handled_at) return { status: "pending" };
  return describeOutcome(intent.kind as (typeof INBOX_INTENTS)[number], intent.result);
}

export type ReviewDeps = Pick<InboxDeps, "db" | "user"> & { pulls: Pick<PullsClient, "pullDetail" | "pullFiles" | "checkState" | "bugbotFindings"> };

/**
 * The changed files and Bugbot's findings the inbox shows: what the runner stored with its decision
 * on this report, else read from GitHub here on the server, as when autonomy is off.
 */
export async function inboxReview(deps: ReviewDeps, jobId: JobId): Promise<ReviewSummary | null> {
  if (!isOwner(await deps.user())) return null;
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job?.pr_url || !inboxKind(job)) return null;
  const decision = mergeDecisionSchema.safeParse(job.merge_decision).data;
  if (decision?.review && (decision.stageEventId === job.stage_event_id || decision.merged)) return decision.review;
  const detail = await deps.pulls.pullDetail(job.pr_url);
  const [files, state, findings] = await Promise.all([
    deps.pulls.pullFiles(job.pr_url),
    deps.pulls.checkState(job.repo as RepoName, detail.headSha),
    deps.pulls.bugbotFindings(job.pr_url),
  ]);
  return reviewSummary({ headSha: detail.headSha, files, bugbot: { review: state.bugbot, findings } });
}
