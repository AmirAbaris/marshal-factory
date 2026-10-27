import { z } from "zod";
import type { JobRow } from "../db/schema";
import { mergeDecisionSchema, type MergeDecision } from "./merge-decision";

// The "Needs you" inbox: every job waiting on the owner, in one list. Pure, so the panel, its
// nav badge, the runner and the regressions share the rules.
//   question       the job is waiting on an answer
//   revert_failed  the factory merged it, main went red, and its revert failed
//   handover       its PR is ready for review: the runner handed it over, autonomy is off, or trial would merge
//   failed         the job failed and the owner has not dismissed it
// The panel's actions become intents the job's runner carries out; their detail shapes live here.

export const INBOX_KINDS = ["question", "revert_failed", "handover", "failed"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export const INBOX_LABELS: Record<InboxKind, string> = {
  question: "Question",
  revert_failed: "Revert failed",
  handover: "Ready for your review",
  failed: "Failed",
};

/** Questions and failed reverts block work or main, so they come first; failures last. */
const RANK: Record<InboxKind, number> = { question: 0, revert_failed: 0, handover: 1, failed: 2 };

export type InboxJob = Pick<JobRow, "key" | "stage" | "stage_at" | "updated_at" | "pr_url" | "merge_decision" | "dismissed_at">;

export type InboxItem<J extends InboxJob = InboxJob> = { kind: InboxKind; job: J; decision: MergeDecision | null; at: Date };

const parseDecision = (value: unknown) => mergeDecisionSchema.safeParse(value).data ?? null;

/** A dismissal hides the failure it saw; one that happened after it shows again. */
export const isDismissed = (job: Pick<JobRow, "dismissed_at" | "stage_at" | "updated_at">) =>
  job.dismissed_at !== null && job.dismissed_at.getTime() >= (job.stage_at ?? job.updated_at).getTime();

/** A PR the factory will not merge on its own; a pending decision or a merge in flight is still the factory's. */
function handedOver(decision: MergeDecision | null) {
  if (!decision) return true;
  if (decision.merging || decision.merged) return false;
  if (decision.autonomy === "off") return true;
  switch (decision.outcome) {
    case "handover":
      return true;
    case "merge":
      return decision.autonomy === "trial";
    case "pending":
      return false;
    default: {
      const never: never = decision.outcome;
      throw new Error(`unknown merge outcome ${String(never)}`);
    }
  }
}

export function inboxKind(job: InboxJob, decision = parseDecision(job.merge_decision)): InboxKind | null {
  switch (job.stage) {
    case "waiting":
      return "question";
    case "pr":
      return job.pr_url && handedOver(decision) ? "handover" : null;
    case "merged":
      return decision?.merged && decision.watch?.state === "revert_failed" && !isDismissed(job) ? "revert_failed" : null;
    case "failed":
      return isDismissed(job) ? null : "failed";
    case "queued":
    case "triage":
    case "investigating":
    case "implementing":
    case "verifying":
      return null;
    default: {
      const never: never = job.stage;
      throw new Error(`unknown stage ${String(never)}`);
    }
  }
}

/** Everything waiting on the owner: questions and failed reverts, then handovers, then failures; newest first within each. */
export function inboxItems<J extends InboxJob>(jobs: readonly J[]): InboxItem<J>[] {
  const items: InboxItem<J>[] = [];
  for (const job of jobs) {
    const decision = parseDecision(job.merge_decision);
    const kind = inboxKind(job, decision);
    if (kind) items.push({ kind, job, decision, at: job.stage_at ?? job.updated_at });
  }
  return items.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.at.getTime() - a.at.getTime() || a.job.key.localeCompare(b.job.key));
}

/** The one line a row gives for why the job is in the inbox. */
export function inboxReason(item: InboxItem<InboxJob & Pick<JobRow, "question" | "stage_summary">>): string {
  const { kind, job, decision } = item;
  switch (kind) {
    case "question":
      return job.question ?? job.stage_summary ?? "The agent is waiting on an answer.";
    case "revert_failed":
      return `Main went red after the merge and the revert failed${decision?.watch?.reason ? `: ${decision.watch.reason}` : "."}`;
    case "handover":
      if (decision?.outcome === "merge" && decision.autonomy === "trial") return "Would merge (trial)";
      return decision?.reasons[0] ?? "Ready for your review";
    case "failed":
      return job.stage_summary ?? "The job failed.";
    default: {
      const never: never = kind;
      throw new Error(`unknown inbox kind ${String(never)}`);
    }
  }
}

/** The actions each kind offers; the panel shows these and the actions refuse the rest. */
export const INBOX_ACTIONS = {
  question: ["answer"],
  revert_failed: ["request_changes", "dismiss"],
  handover: ["approve", "request_changes", "close"],
  failed: ["close", "dismiss"],
} as const satisfies Record<InboxKind, readonly InboxAction[]>;
export type InboxAction = "answer" | "approve" | "request_changes" | "close" | "dismiss";

export const allows = (kind: InboxKind | null, action: InboxAction) =>
  kind !== null && (INBOX_ACTIONS[kind] as readonly InboxAction[]).includes(action);

export const MAX_FEEDBACK_CHARS = 20_000;

/** An approve_merge intent: the owner, and the head they reviewed; null when they saw no head. */
export const approveDetailSchema = z.object({ actor: z.string(), headSha: z.string().nullable() });
export type ApproveDetail = z.infer<typeof approveDetailSchema>;

/** A request_changes intent. `id` is the replay key: one per panel request or GitHub review. */
export const feedbackDetailSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("panel"), id: z.string(), actor: z.string(), body: z.string() }),
  z.object({ from: z.literal("github"), id: z.string(), reviewId: z.number().int(), reviewer: z.string(), state: z.string(), body: z.string() }),
]);
export type FeedbackDetail = z.infer<typeof feedbackDetailSchema>;

export const closeDetailSchema = z.object({ actor: z.string(), reason: z.string() });
export type CloseDetail = z.infer<typeof closeDetailSchema>;

export type ReviewComment = { path: string; line: number | null; body: string };

const quote = (text: string) => text.trim().replace(/^/gm, "> ");

/** The turn a thread gets when the owner, in the panel or on GitHub, asks for changes. */
export function changesMessage({
  prUrl,
  feedback,
  comments = [],
  revertFailed = false,
}: {
  prUrl: string;
  feedback: FeedbackDetail;
  comments?: readonly ReviewComment[];
  revertFailed?: boolean;
}) {
  const who = feedback.from === "github" ? `The reviewer (@${feedback.reviewer} on GitHub)` : "The reviewer";
  const lead = revertFailed
    ? `Main went red after the factory merged ${prUrl}, and the automatic revert failed. ${who} asked for changes:`
    : `${who} requested changes on ${prUrl}:`;
  const next = revertFailed
    ? "Fix main in a new pull request from a fresh branch off main, then report it with report_stage and a fresh assessment."
    : "Update the same branch and PR, then report the PR again with a fresh assessment.";
  return [
    lead,
    "",
    ...(feedback.body.trim() ? [quote(feedback.body), ""] : []),
    ...(comments.length > 0
      ? ["Comments on the code:", "", ...comments.flatMap((c) => [`- ${c.path}${c.line ? `:${c.line}` : ""}`, quote(c.body).replace(/^/gm, "  "), ""])]
      : []),
    next,
  ].join("\n");
}
