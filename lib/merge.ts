import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, ne, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";
import { auditLog, jobs, type AuditRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { PullsClient } from "@/lib/github/pulls";
import type { JobId } from "@/lib/sources/shapes";

// Merging a factory PR from the panel. Every attempt the owner makes is recorded in audit_log:
// a refusal before GitHub is asked writes one merge_failed row, and a request GitHub is asked to
// carry out writes merge_requested and then merge_succeeded or merge_failed. A non-owner gets
// nothing written. The job moves to merged the usual way, when GitHub's webhook arrives.

export type MergeDeps = {
  db: NodePgDatabase<typeof schema>;
  user: () => Promise<SessionUser | null | undefined>;
  pulls: Pick<PullsClient, "pullRequest" | "mergePull">;
  now?: () => Date;
};

type Result = NonNullable<AuditRow["result"]>;

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; status: 403 | 404 | 409 | 502; reason: Result | "forbidden" | "not_found" | "in_progress"; message: string };

export type MergeTarget = { title: string; headSha: string; repo: string; prUrl: string; mergeable: "mergeable" | "conflicting" | "unknown" };

/** A request with no outcome this recent is still running; an older one died with its request. */
const IN_FLIGHT_MS = 2 * 60_000;

const STATUS: Record<Exclude<Result, "ok">, 409 | 502> = {
  head_moved: 409,
  not_mergeable: 409,
  refused: 409,
  error: 502,
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function ownerJob(deps: MergeDeps, jobId: JobId) {
  const user = await deps.user();
  if (!isOwner(user)) return { kind: "denied", outcome: { ok: false, status: 403, reason: "forbidden", message: "Only the factory owner can merge." } } as const;
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { kind: "denied", outcome: { ok: false, status: 404, reason: "not_found", message: `No job ${jobId}.` } } as const;
  return { kind: "owner", actor: user!.email, job } as const;
}

/** What the merge dialog shows: read when run detail opens, so the head is the one the owner saw. */
export async function mergeTarget(deps: MergeDeps, jobId: JobId): Promise<MergeTarget | null> {
  const found = await ownerJob(deps, jobId);
  if (found.kind === "denied" || found.job.stage !== "pr" || !found.job.pr_url) return null;
  const pull = await deps.pulls.pullRequest(found.job.pr_url);
  if (pull.state !== "open") return null;
  return { title: pull.title, headSha: pull.headSha, repo: found.job.repo, prUrl: found.job.pr_url, mergeable: pull.mergeable };
}

export async function mergeJob(deps: MergeDeps, jobId: JobId, expectedHeadSha: string): Promise<MergeOutcome> {
  const now = deps.now ?? (() => new Date());
  const found = await ownerJob(deps, jobId);
  if (found.kind === "denied") return found.outcome;
  const { actor, job } = found;
  const target = job.pr_url ?? "";

  const write = (db: Pick<MergeDeps["db"], "insert">, action: AuditRow["action"], result: Result | null, detail: string | null) =>
    db.insert(auditLog).values({ id: randomUUID(), at: now(), actor, action, job_id: job.id, target, head_sha: expectedHeadSha, result, detail });
  const failed = async (result: Exclude<Result, "ok">, detail: string): Promise<MergeOutcome> => {
    await write(deps.db, "merge_failed", result, detail);
    return { ok: false, status: STATUS[result], reason: result, message: detail };
  };

  if (job.stage !== "pr" || !job.pr_url) return failed("refused", `The job is in ${job.stage}, not waiting on a pull request.`);
  let pull;
  try {
    pull = await deps.pulls.pullRequest(job.pr_url);
  } catch (error) {
    return failed("error", message(error));
  }
  if (pull.state !== "open") return failed("refused", `The pull request is already ${pull.state}.`);
  if (pull.headSha !== expectedHeadSha) {
    return failed("head_moved", `The pull request moved to ${pull.headSha.slice(0, 7)} since you opened it.`);
  }
  if (pull.mergeable === "conflicting") return failed("not_mergeable", "The pull request conflicts with its base branch.");

  // One request per commit: a second click waits for the first insert, then sees it running or
  // done. GitHub can still call the PR open for a moment after the first merge.
  const claim = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`merge:${job.id}`}))`);
    const [last] = await tx
      .select({ action: auditLog.action, at: auditLog.at })
      .from(auditLog)
      .where(and(eq(auditLog.job_id, job.id), eq(auditLog.head_sha, expectedHeadSha), ne(auditLog.action, "merge_failed")))
      // An outcome is written after its request, so it wins a tie on the clock.
      .orderBy(desc(auditLog.at), sql`${auditLog.action} = 'merge_requested'`)
      .limit(1);
    if (last?.action === "merge_succeeded") return "merged" as const;
    if (last?.action === "merge_requested" && last.at.getTime() > now().getTime() - IN_FLIGHT_MS) {
      const [outcome] = await tx
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(and(eq(auditLog.job_id, job.id), eq(auditLog.head_sha, expectedHeadSha), eq(auditLog.action, "merge_failed"), gte(auditLog.at, last.at)))
        .limit(1);
      if (!outcome) return "running" as const;
    }
    await write(tx, "merge_requested", null, null);
    return "claimed" as const;
  });
  if (claim === "merged") return { ok: false, status: 409, reason: "refused", message: "This commit was already merged from the panel." };
  if (claim === "running") return { ok: false, status: 409, reason: "in_progress", message: "A merge of this commit is already running." };

  let merged;
  try {
    merged = await deps.pulls.mergePull(job.pr_url, expectedHeadSha);
  } catch (error) {
    return failed("error", message(error));
  }
  switch (merged.kind) {
    case "merged":
      await write(deps.db, "merge_succeeded", "ok", `Squashed as ${merged.sha.slice(0, 7)}.`);
      return { ok: true, sha: merged.sha };
    case "head_moved":
      return failed("head_moved", merged.message || "The pull request head moved.");
    case "not_mergeable":
      return failed("not_mergeable", merged.message || "GitHub says the pull request is not mergeable.");
    case "forbidden":
      return failed("refused", `The factory's GitHub App can't merge in this repo: ${merged.message}`);
    default: {
      const unhandled: never = merged;
      throw new Error(`unknown merge result ${JSON.stringify(unhandled)}`);
    }
  }
}
