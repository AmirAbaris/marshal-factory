import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, jobs, type AuditRow } from "../db/schema";
import { parseAssessment } from "../lib/assessment";
import { attemptBranch } from "../lib/factory";
import type { RepoName } from "../lib/github/app";
import { github, parsePullUrl, type MergeCandidate } from "../lib/github/pulls";
import { DECISION_MARKER, fingerprint, prCommentBody, sourceCommentBody } from "../lib/merge-comments";
import { blockedReason, mergeDecisionSchema, type MergeDecision, type MergeMethod, type MergeVia } from "../lib/merge-decision";
import { parseJobs, sourceFor } from "../lib/sources";
import type { Job } from "../lib/sources/types";
import { runnerEventId } from "../lib/stages";
import { config } from "./config";
import { postMerged } from "./ops";

// The factory's one way to merge a pull request. Auto-merge (decideMerges), the owner's approval
// in the inbox and the owner's approval in run detail (both approveMerge) all end in mergeNow:
// the head re-read and pinned, the repo's method, the App's push access, the intent to merge
// stored before GitHub is asked so a crash right after is recorded later, the merge recorded once
// with who asked for it, the post-merge watch started, the decision comments and the source note
// posted, and the audit rows. The revert the watch opens merges here too. Nothing else in the
// factory calls GitHub's merge endpoint; lint keeps it that way.

export const storedDecision = (job: Pick<Job, "merge_decision">) => mergeDecisionSchema.safeParse(job.merge_decision).data ?? null;

const sameDecision = (a: MergeDecision | null, b: MergeDecision) =>
  a !== null &&
  a.outcome === b.outcome &&
  a.autonomy === b.autonomy &&
  a.headSha === b.headSha &&
  a.reasons.length === b.reasons.length &&
  a.reasons.every((r, i) => r === b.reasons[i]);

function auditDetail({ outcome, reasons, autonomy }: MergeDecision) {
  switch (outcome) {
    case "merge":
      return [autonomy === "auto" ? "Merging (auto)" : `Would merge (${autonomy})`, ...reasons].join(" · ");
    case "pending":
      return ["Pending", ...reasons].join(" · ");
    case "handover":
      return ["Hand over", ...reasons].join(" · ");
    default: {
      const never: never = outcome;
      throw new Error(`unknown merge outcome ${String(never)}`);
    }
  }
}

type Tx = Pick<typeof db, "insert">;

export const auditFactory = (tx: Tx, job: Job, at: Date, action: AuditRow["action"], headSha: string, detail: string, result: AuditRow["result"] = null, actor = "factory") =>
  tx.insert(auditLog).values({ id: randomUUID(), at, actor, action, job_id: job.id, target: job.pr_url!, head_sha: headSha, result, detail: detail.slice(0, 2000) });

/** Who a merge is audited for: the factory for its own, the owner who approved it otherwise. */
const actorOf = (via: MergeVia, decision: MergeDecision) => (via === "auto" ? "factory" : (decision.approvedBy ?? "factory"));

/** Stores the decision unless the job left the report it was made for; audits it when it changed. */
export async function storeDecision(job: Job, previous: MergeDecision | null, next: MergeDecision): Promise<"gone" | "same" | "changed"> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ merge_decision: next })
      .where(and(eq(jobs.id, job.id), eq(jobs.stage, "pr"), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning({ id: jobs.id });
    if (updated.length === 0) return "gone";
    if (sameDecision(previous, next)) return "same";
    await auditFactory(tx, job, new Date(next.evaluatedAt), "merge_decided", next.headSha ?? "", auditDetail(next));
    return "changed";
  });
}

/**
 * Posts the decision's PR comment and source comment when their text changed since the last post.
 * The PR comment carries a marker and is edited in place; the source comment's key includes the
 * text, so a replay finds the one already posted.
 */
export async function syncComments(job: Job, decision: MergeDecision): Promise<MergeDecision> {
  const prBody = prCommentBody(decision, parseAssessment(job.merge_assessment));
  const sourceBody = sourceCommentBody(decision, job.pr_url!);
  const comments = { ...decision.comments };
  if (prBody && fingerprint(prBody) !== comments.pr) {
    await github.upsertComment(job.pr_url!, DECISION_MARKER, prBody);
    comments.pr = fingerprint(prBody);
  }
  if (sourceBody && fingerprint(sourceBody) !== comments.source) {
    await sourceFor(job.source).note(job, `decision:${fingerprint(sourceBody)}:${decision.evaluatedAt}`, sourceBody);
    comments.source = fingerprint(sourceBody);
  }
  if (comments.pr === decision.comments?.pr && comments.source === decision.comments?.source) return decision;
  await db
    .update(jobs)
    .set({ merge_decision: sql`jsonb_set(${jobs.merge_decision}, '{comments}', ${JSON.stringify(comments)}::jsonb)` })
    .where(eq(jobs.id, job.id));
  return { ...decision, comments };
}

const commitMessage = (job: Job) => [(job.stage_summary ?? parseAssessment(job.merge_assessment)?.interpretation ?? "").slice(0, 1000), "Merged by the factory"].filter(Boolean).join("\n\n");

function mergeSnapshot(decision: MergeDecision, sha: string, method: MergeMethod, via: MergeVia, job: Job) {
  const a = parseAssessment(job.merge_assessment);
  return [
    `Merged by the factory as ${sha.slice(0, 7)} (${method}) via ${via}`,
    ...decision.reasons,
    a ? `Interpretation: ${a.interpretation.slice(0, 600)}` : "No assessment",
    a?.assumptions.length ? `Assumptions: ${a.assumptions.join("; ").slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const notMerged = sql`not (coalesce(${jobs.merge_decision}, '{}'::jsonb) ? 'merged')`;

/** Records the merge, starts the watch and posts the comments once; null when an earlier pass already recorded it. */
async function recordMerge(job: Job, decision: MergeDecision, pull: MergeCandidate, method: MergeMethod, sha: string, via: MergeVia, now: number) {
  const at = new Date(now);
  const next: MergeDecision = {
    ...decision,
    merging: undefined,
    merged: { sha, method, at: at.toISOString(), base: pull.baseRef, title: pull.title, commits: pull.commits, via },
    watch: { state: "watching", until: new Date(now + config.factory.postMergeWatchMinutes * 60_000).toISOString(), failed: [], revertPr: null, reason: null },
  };
  const recorded = await db.transaction(async (tx) => {
    const updated = await tx.update(jobs).set({ merge_decision: next }).where(and(eq(jobs.id, job.id), notMerged)).returning({ id: jobs.id });
    if (updated.length === 0) return false;
    await auditFactory(tx, job, at, "merge_succeeded", pull.headSha, mergeSnapshot(decision, sha, method, via, job), "ok", actorOf(via, decision));
    return true;
  });
  if (!recorded) return null;
  const branchToDelete = pull.headRef ?? attemptBranch(job.key, job.attempt);
  if (branchToDelete && job.pr_url) {
    const { repo } = parsePullUrl(job.pr_url);
    await github.deleteBranch(repo, branchToDelete).catch(() => false);
  }
  await postMerged(job.key, job.pr_url!, job.session_id ?? runnerEventId("merged", job.external_id));
  return syncComments(job, next);
}

/** Stores the intent to merge this head; null when the job left the report the decision was made for. */
async function markMerging(job: Job, decision: MergeDecision, method: MergeMethod, via: MergeVia, now: number): Promise<MergeDecision | null> {
  const next: MergeDecision = { ...decision, merging: { headSha: decision.headSha!, method, at: new Date(now).toISOString(), via } };
  const updated = await db
    .update(jobs)
    .set({ merge_decision: next })
    .where(and(eq(jobs.id, job.id), eq(jobs.stage, "pr"), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`, notMerged))
    .returning({ id: jobs.id });
  return updated.length === 0 ? null : next;
}

async function block(job: Job, decision: MergeDecision, detail: string) {
  const next: MergeDecision = { ...decision, merging: undefined, outcome: "handover", reasons: [blockedReason(detail)], blocked: detail };
  return (await storeDecision(job, decision, next)) === "gone" ? null : syncComments(job, next);
}

/**
 * Merges the PR the decision is about, at the head it was made for. Null when the head moved or
 * the PR left pr, so the caller decides again; otherwise the decision as stored and commented:
 * merged, or handed over with GitHub's refusal.
 */
export async function mergeNow(job: Job, evaluated: MergeDecision, via: MergeVia, now: number): Promise<MergeDecision | null> {
  const url = job.pr_url!;
  const pull = await github.mergeCandidate(url);
  if (pull.state !== "open" || pull.headSha !== evaluated.headSha) return null;
  const { method, canPush } = await github.repoMerging(job.repo as RepoName);
  if (!canPush) return block(job, evaluated, "it has no write access to the repo's contents.");
  const decision = await markMerging(job, evaluated, method, via, now);
  if (!decision) return null;
  const result = await github.mergePull(url, pull.headSha, { method, title: `${pull.title} (#${pull.number})`, message: commitMessage(job) });
  switch (result.kind) {
    case "merged":
      return recordMerge(job, decision, pull, method, result.sha, via, now);
    case "forbidden":
      return block(job, decision, result.message);
    case "not_mergeable":
    case "head_moved": {
      const after = await github.mergeCandidate(url);
      // A merge that already went through, such as a replay after a crash, counts as this one.
      if (after.state === "merged" && after.headSha === pull.headSha && after.mergeCommitSha) return recordMerge(job, decision, pull, method, after.mergeCommitSha, via, now);
      if (after.state !== "open" || after.headSha !== pull.headSha) return null;
      return block(job, decision, result.message || `GitHub refused the merge (${result.kind === "head_moved" ? 409 : 405}).`);
    }
    default: {
      const never: never = result;
      throw new Error(`unknown merge result ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Records the merges GitHub made but the factory never wrote down, such as after a crash right
 * after the merge call; checkPullRequests may already have moved the job to merged. Only a merge
 * of the intended head by an App counts; anything else drops the intent.
 */
export async function recoverMerges(machineId: string, only: string[] | undefined, now: number, changed: string[], errors: { key: string; error: string }[]) {
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.machine_id, machineId),
          inArray(jobs.stage, ["pr", "merged"]),
          isNotNull(jobs.pr_url),
          sql`${jobs.merge_decision} ? 'merging'`,
          notMerged,
          only ? inArray(jobs.key, only) : undefined,
        ),
      ),
  );
  for (const job of rows) {
    try {
      const decision = storedDecision(job);
      const intent = decision?.merging;
      if (!decision || !intent) continue;
      const pull = await github.mergeCandidate(job.pr_url!);
      // Still open: the main pass merges it or decides again.
      if (pull.state === "open") continue;
      if (pull.state === "merged" && pull.headSha === intent.headSha && pull.mergeCommitSha && pull.mergedByBot) {
        const recorded = await recordMerge(job, decision, pull, intent.method, pull.mergeCommitSha, intent.via ?? "auto", now);
        if (recorded) changed.push(`${job.key}:merged`);
        continue;
      }
      await db
        .update(jobs)
        .set({ merge_decision: sql`${jobs.merge_decision} - 'merging'` })
        .where(and(eq(jobs.id, job.id), notMerged));
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Merges the factory's own revert PR at the head it pushed; the post-merge watch's way back to green. */
export const mergeRevert = (url: string, head: string, method: MergeMethod, title: string) => github.mergePull(url, head, { method, title, message: "Reverted by the factory" });
