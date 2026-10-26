import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, jobs } from "../db/schema";
import { attemptBranch } from "../lib/factory";
import type { RepoName } from "../lib/github/app";
import { github } from "../lib/github/pulls";
import { decideMerge, mergeDecisionSchema, OFF_DECISION, type Decision, type MergeDecision, type PrFacts, type RepoPolicy } from "../lib/merge-decision";
import { readRepoSettings, resolvePolicy } from "../lib/settings";
import { parseJobs, sourceFor } from "../lib/sources";
import type { Job } from "../lib/sources/types";
import { branchSpend } from "../lib/spend";
import { thisMachine } from "./heartbeat";
import { harnessDrivers, jobTracked } from "./ops";

// The timer's pass over this machine's jobs in pr: decides whether each PR would merge on its own
// and stores the decision on the job. GitHub and the source only; a hibernated sandbox stays
// asleep. A settled decision is read again when the head, the report or the autonomy changes, or
// after RECHECK_MS; a pending one every pass. The audit log gets a row only when the decision
// changes. Nothing merges yet.

export const RECHECK_MS = 15 * 60_000;

const storedDecision = (job: Job) => mergeDecisionSchema.safeParse(job.merge_decision).data ?? null;

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
      return [`Would merge (${autonomy})`, ...reasons].join(" · ");
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

async function prFacts(prUrl: string, repo: RepoName, headSha: string, baseRef: string, mergeable: PrFacts["mergeable"]): Promise<PrFacts> {
  const [behindBy, files, state, findings] = await Promise.all([
    github.behindBy(repo, baseRef, headSha),
    github.pullFiles(prUrl),
    github.checkState(repo, headSha),
    github.bugbotFindings(prUrl),
  ]);
  return { headSha, mergeable, behindBy, files, checks: state.checks, bugbot: { finished: state.bugbotFinished, findings } };
}

type Evaluated = { decision: Decision; headSha: string | null; headSeenAt: number | null } | "unchanged";

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
  if (sameReport && sameHead && fresh && previous.outcome !== "pending") return "unchanged";

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
  return { decision, headSha: detail.headSha, headSeenAt };
}

/** Stores the decision unless the job left the report it was made for; audits it when it changed. */
async function store(job: Job, previous: MergeDecision | null, next: MergeDecision) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ merge_decision: next })
      .where(and(eq(jobs.id, job.id), eq(jobs.stage, "pr"), sql`${jobs.stage_event_id} is not distinct from ${job.stage_event_id}`))
      .returning({ id: jobs.id });
    if (updated.length === 0 || sameDecision(previous, next)) return false;
    await tx.insert(auditLog).values({
      id: randomUUID(),
      at: new Date(next.evaluatedAt),
      actor: "factory",
      action: "merge_decided",
      job_id: job.id,
      target: job.pr_url!,
      head_sha: next.headSha ?? "",
      detail: auditDetail(next).slice(0, 2000),
    });
    return true;
  });
}

export async function decideMerges({ now = Date.now(), only }: { now?: number; only?: string[] } = {}) {
  const machine = await thisMachine();
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.machine_id, machine.id), eq(jobs.stage, "pr"), isNotNull(jobs.pr_url), only ? inArray(jobs.key, only) : undefined)),
  );
  if (rows.length === 0) return [];
  const policies = await readRepoSettings(db);
  const drivers = harnessDrivers();
  const changed: string[] = [];
  const errors: { key: string; error: string }[] = [];
  for (const job of rows) {
    try {
      const policy = resolvePolicy(policies, job.repo);
      const previous = storedDecision(job);
      const result = await evaluate(job, policy, previous, jobTracked(job, drivers), now);
      if (result === "unchanged") continue;
      const next: MergeDecision = {
        ...result.decision,
        autonomy: policy.autonomy,
        evaluatedAt: new Date(now).toISOString(),
        headSha: result.headSha,
        headSeenAt: result.headSeenAt === null ? null : new Date(result.headSeenAt).toISOString(),
        stageEventId: job.stage_event_id,
      };
      if (await store(job, previous, next)) changed.push(`${job.key}:${next.outcome}`);
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors.length > 0 ? { changed, errors } : changed;
}
