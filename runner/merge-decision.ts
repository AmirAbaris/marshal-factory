import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, jobs, type AuditRow } from "../db/schema";
import { attemptBranch } from "../lib/factory";
import type { ApproveDetail } from "../lib/inbox";
import type { RepoName } from "../lib/github/app";
import { github, type MergeCandidate } from "../lib/github/pulls";
import { DECISION_MARKER, fingerprint, prCommentBody, sourceCommentBody } from "../lib/merge-comments";
import {
  approvalBlockers,
  blockedReason,
  decideMerge,
  mergeDecisionSchema,
  OFF_DECISION,
  type Decision,
  type MergeDecision,
  type MergeMethod,
  type PrFacts,
  type RepoPolicy,
  type ReviewSummary,
  reviewSummary,
} from "../lib/merge-decision";
import { readRepoSettings, resolvePolicy } from "../lib/settings";
import { parseJob, parseJobs, sourceFor } from "../lib/sources";
import type { Job, JobId } from "../lib/sources/types";
import { branchSpend } from "../lib/spend";
import { runnerEventId } from "../lib/stages";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { harnessDrivers, jobTracked, postMerged } from "./ops";

// The timer's pass over this machine's jobs in pr: decides whether each PR merges on its own and
// stores the decision on the job. GitHub and the source only; a hibernated sandbox stays asleep.
// A settled decision is read again when the head, the report or the autonomy changes, or after
// RECHECK_MS; a pending one, and a merge under auto, every pass. The audit log gets a row only
// when the decision changes. Under auto a merge decision merges at once, on facts read in the
// same pass and with the head pinned; a refusal hands over and is not retried for that head. The
// intent to merge is stored before the merge call, so a crash right after it is recorded later.

export const RECHECK_MS = 15 * 60_000;

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

export const auditFactory = (tx: Tx, job: Job, at: Date, action: AuditRow["action"], headSha: string, detail: string, result: AuditRow["result"] = null) =>
  tx.insert(auditLog).values({ id: randomUUID(), at, actor: "factory", action, job_id: job.id, target: job.pr_url!, head_sha: headSha, result, detail: detail.slice(0, 2000) });

async function prFacts(prUrl: string, repo: RepoName, headSha: string, baseRef: string, mergeable: PrFacts["mergeable"]): Promise<PrFacts> {
  const [behindBy, files, state, findings] = await Promise.all([
    github.behindBy(repo, baseRef, headSha),
    github.pullFiles(prUrl),
    github.checkState(repo, headSha),
    github.bugbotFindings(prUrl),
  ]);
  return { headSha, mergeable, behindBy, files, checks: state.checks, bugbot: { review: state.bugbot, findings } };
}

type Evaluated = { decision: Decision; headSha: string | null; headSeenAt: number | null; review?: ReviewSummary } | "unchanged";

async function evaluate(job: Job, policy: RepoPolicy, previous: MergeDecision | null, tracked: boolean, now: number): Promise<Evaluated> {
  const sameReport = previous !== null && previous.autonomy === policy.autonomy && previous.stageEventId === job.stage_event_id;
  if (policy.autonomy === "off") {
    return sameReport ? "unchanged" : { decision: OFF_DECISION, headSha: null, headSeenAt: null };
  }
  const detail = await github.pullDetail(job.pr_url!);
  // A merged or closed PR is checkPullRequests' to follow.
  if (detail.state !== "open") return "unchanged";
  const sameHead = previous?.headSha === detail.headSha;
  const fresh = previous !== null && now - Date.parse(previous.evaluatedAt) < RECHECK_MS;
  const unsettled = previous?.outcome === "pending" || (previous?.outcome === "merge" && previous.autonomy === "auto");
  if (sameReport && sameHead && fresh && !unsettled) return "unchanged";

  const branch = attemptBranch(job.key, job.attempt);
  const [pr, labels, spend] = await Promise.all([
    prFacts(job.pr_url!, job.repo as RepoName, detail.headSha, detail.baseRef, detail.mergeable),
    sourceFor(job.source).labels(job),
    branchSpend(db, [branch]),
  ]);
  const headSeenAt = sameHead && previous.headSeenAt ? Date.parse(previous.headSeenAt) : now;
  const decision = decideMerge({
    policy,
    tracked,
    assessment: job.merge_assessment,
    attempt: job.attempt,
    spendUsd: spend[branch] ?? 0,
    budgetUsd: job.budget_usd,
    labels,
    pr,
    headSeenAt,
    now,
  });
  return { decision, headSha: detail.headSha, headSeenAt, review: reviewSummary(pr) };
}

/** Stores the decision unless the job left the report it was made for; audits it when it changed. */
async function store(job: Job, previous: MergeDecision | null, next: MergeDecision): Promise<"gone" | "same" | "changed"> {
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
  const prBody = prCommentBody(decision, job.merge_assessment);
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

const commitMessage = (job: Job) => [(job.stage_summary ?? job.merge_assessment?.interpretation ?? "").slice(0, 1000), "Merged by the factory"].filter(Boolean).join("\n\n");

function mergeSnapshot(decision: MergeDecision, sha: string, method: MergeMethod, job: Job) {
  const a = job.merge_assessment;
  return [
    `Merged by the factory as ${sha.slice(0, 7)} (${method})`,
    ...decision.reasons,
    a ? `Interpretation: ${a.interpretation.slice(0, 600)}` : "No assessment",
    a?.assumptions.length ? `Assumptions: ${a.assumptions.join("; ").slice(0, 600)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const notMerged = sql`not (coalesce(${jobs.merge_decision}, '{}'::jsonb) ? 'merged')`;

/** Records the merge and starts the watch once; null when an earlier pass already recorded it. */
async function recordMerge(job: Job, decision: MergeDecision, pull: MergeCandidate, method: MergeMethod, sha: string, now: number) {
  const at = new Date(now);
  const next: MergeDecision = {
    ...decision,
    merging: undefined,
    merged: { sha, method, at: at.toISOString(), base: pull.baseRef, title: pull.title, commits: pull.commits },
    watch: { state: "watching", until: new Date(now + config.factory.postMergeWatchMinutes * 60_000).toISOString(), failed: [], revertPr: null, reason: null },
  };
  const recorded = await db.transaction(async (tx) => {
    const updated = await tx.update(jobs).set({ merge_decision: next }).where(and(eq(jobs.id, job.id), notMerged)).returning({ id: jobs.id });
    if (updated.length === 0) return false;
    await auditFactory(tx, job, at, "merge_succeeded", pull.headSha, mergeSnapshot(decision, sha, method, job), "ok");
    return true;
  });
  if (!recorded) return null;
  await postMerged(job.key, job.pr_url!, job.session_id ?? runnerEventId("merged", job.external_id));
  return next;
}

/** Stores the intent to merge this head; null when the job left the report the decision was made for. */
async function markMerging(job: Job, decision: MergeDecision, method: MergeMethod, now: number): Promise<MergeDecision | null> {
  const next: MergeDecision = { ...decision, merging: { headSha: decision.headSha!, method, at: new Date(now).toISOString() } };
  const updated = await db
    .update(jobs)
    .set({ merge_decision: next })
    .where(and(eq(jobs.id, job.id), eq(jobs.stage, "pr"), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`, notMerged))
    .returning({ id: jobs.id });
  return updated.length === 0 ? null : next;
}

async function block(job: Job, decision: MergeDecision, detail: string) {
  const next: MergeDecision = { ...decision, merging: undefined, outcome: "handover", reasons: [blockedReason(detail)], blocked: detail };
  return (await store(job, decision, next)) === "gone" ? null : next;
}

/** Merges the PR the decision is about; null when the head moved or the PR left pr, so the next pass decides again. */
async function mergeNow(job: Job, evaluated: MergeDecision, now: number): Promise<MergeDecision | null> {
  const url = job.pr_url!;
  const pull = await github.mergeCandidate(url);
  if (pull.state !== "open" || pull.headSha !== evaluated.headSha) return null;
  const { method, canPush } = await github.repoMerging(job.repo as RepoName);
  if (!canPush) return block(job, evaluated, "it has no write access to the repo's contents.");
  const decision = await markMerging(job, evaluated, method, now);
  if (!decision) return null;
  const result = await github.mergePull(url, pull.headSha, { method, title: `${pull.title} (#${pull.number})`, message: commitMessage(job) });
  switch (result.kind) {
    case "merged":
      return recordMerge(job, decision, pull, method, result.sha, now);
    case "forbidden":
      return block(job, decision, result.message);
    case "not_mergeable":
    case "head_moved": {
      const after = await github.mergeCandidate(url);
      // A merge that already went through, such as a replay after a crash, counts as this one.
      if (after.state === "merged" && after.headSha === pull.headSha && after.mergeCommitSha) return recordMerge(job, decision, pull, method, after.mergeCommitSha, now);
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
async function recoverMerges(machineId: string, only: string[] | undefined, now: number, changed: string[], errors: { key: string; error: string }[]) {
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
        const recorded = await recordMerge(job, decision, pull, intent.method, pull.mergeCommitSha, now);
        if (recorded) {
          changed.push(`${job.key}:merged`);
          await syncComments(job, recorded);
        }
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

export async function decideMerges({ now = Date.now(), only }: { now?: number; only?: string[] } = {}) {
  const machine = await thisMachine();
  const changed: string[] = [];
  const errors: { key: string; error: string }[] = [];
  await recoverMerges(machine.id, only, now, changed, errors);
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.machine_id, machine.id), eq(jobs.stage, "pr"), isNotNull(jobs.pr_url), only ? inArray(jobs.key, only) : undefined)),
  );
  if (rows.length === 0) return errors.length > 0 ? { changed, errors } : changed;
  const policies = await readRepoSettings(db);
  const drivers = harnessDrivers();
  for (const job of rows) {
    try {
      const policy = resolvePolicy(policies, job.repo);
      const previous = storedDecision(job);
      const result = await evaluate(job, policy, previous, jobTracked(job, drivers), now);
      if (result === "unchanged") {
        if (previous) await syncComments(job, previous);
        continue;
      }
      // GitHub refused this head before; asking again would only be refused again.
      const blocked = previous?.blocked && previous.headSha === result.headSha ? previous.blocked : undefined;
      const decision = blocked && result.decision.outcome === "merge" && policy.autonomy === "auto" ? { outcome: "handover" as const, reasons: [blockedReason(blocked)] } : result.decision;
      const next: MergeDecision = {
        ...decision,
        autonomy: policy.autonomy,
        evaluatedAt: new Date(now).toISOString(),
        headSha: result.headSha,
        headSeenAt: result.headSeenAt === null ? null : new Date(result.headSeenAt).toISOString(),
        stageEventId: job.stage_event_id,
        ...(blocked && { blocked }),
        ...(previous?.comments && { comments: previous.comments }),
        ...(result.review && { review: result.review }),
      };
      const stored = await store(job, previous, next);
      if (stored === "gone") continue;
      if (stored === "changed") changed.push(`${job.key}:${next.outcome}`);
      let current = next;
      if (next.outcome === "merge" && next.autonomy === "auto") {
        const merged = await mergeNow(job, next, now);
        if (merged) {
          current = merged;
          changed.push(`${job.key}:${merged.merged ? "merged" : merged.outcome}`);
        }
      }
      await syncComments(job, current);
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors.length > 0 ? { changed, errors } : changed;
}

export type Approval = { merged: string } | { blocked: string } | { refused: string };

/**
 * Merges a PR the owner approved in the inbox, through the same merge as auto: the head pinned,
 * the repo's method, a refusal handed over and recorded, the merge recorded and watched on main.
 * The agent's and the policy's reasons are the owner's to overrule; facts about the PR still stop
 * it. A replay after the merge finds it recorded and changes nothing.
 */
export async function approveMerge(id: JobId, { actor, headSha }: ApproveDetail, now = Date.now()): Promise<Approval> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  if (!row) return { refused: `No job ${id}.` };
  const job = parseJob(row);
  const previous = storedDecision(job);
  if (previous?.merged) return { merged: previous.merged.sha };
  if (job.stage !== "pr" || !job.pr_url) return { refused: `The job is in ${job.stage}, not waiting on a pull request.` };
  const detail = await github.pullDetail(job.pr_url);
  if (detail.state !== "open") return { refused: `The pull request is already ${detail.state}.` };
  if (headSha && detail.headSha !== headSha) {
    return { refused: `The pull request moved to ${detail.headSha.slice(0, 7)} since you reviewed ${headSha.slice(0, 7)}. Review the new commit first.` };
  }
  const pr = await prFacts(job.pr_url, job.repo as RepoName, detail.headSha, detail.baseRef, detail.mergeable);
  const blockers = approvalBlockers(pr);
  if (blockers.length > 0) return { blocked: blockers.join(" ") };
  const policy = resolvePolicy(await readRepoSettings(db), job.repo);
  const iso = new Date(now).toISOString();
  const approved: MergeDecision = {
    ...previous,
    outcome: "merge",
    reasons: [`Approved in the inbox by ${actor}.`],
    autonomy: policy.autonomy,
    evaluatedAt: iso,
    headSha: detail.headSha,
    headSeenAt: previous?.headSha === detail.headSha ? previous.headSeenAt : iso,
    stageEventId: job.stage_event_id,
    review: reviewSummary(pr),
    approvedBy: actor,
    blocked: undefined,
    merging: undefined,
  };
  await db.insert(auditLog).values({
    id: randomUUID(),
    at: new Date(now),
    actor,
    action: "merge_requested",
    job_id: job.id,
    target: job.pr_url,
    head_sha: detail.headSha,
    detail: "Approved in the inbox",
  });
  const merged = await mergeNow(job, approved, now);
  if (!merged) return { refused: "The pull request changed while it was merging. Review it again." };
  await syncComments(job, merged);
  if (merged.merged) return { merged: merged.merged.sha };
  return { blocked: merged.reasons.join(" ") };
}
