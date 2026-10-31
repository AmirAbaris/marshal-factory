import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs } from "../db/schema";
import { installationTokens, type RepoName } from "../lib/github/app";
import { github, parsePullUrl } from "../lib/github/pulls";
import { localHost, type JobHost } from "../lib/host";
import type { FactoryMerge, MergeDecision, MergeWatch } from "../lib/merge-decision";
import { parseJobs } from "../lib/sources";
import type { Job } from "../lib/sources/types";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { auditFactory, mergeRevert, storedDecision, syncComments } from "./merge-service";
import { factoryCheckouts } from "./ops";

// After the factory merges a PR, the timer watches the merge commit's checks on the base branch
// for factory.postMergeWatchMinutes. Green or no verdict in time ends the watch. Red reverts the
// merge with a PR the factory opens and merges at once, from a temporary worktree of this
// machine's checkout. Each watch ends in one state and is never retried: a failed revert stops
// there, for the owner to finish.

/** Where reverts run; regressions swap in a fake host, token and checkout. */
export const revertDeps: {
  host: JobHost;
  token: (repo: RepoName) => Promise<string>;
  checkout: (repo: RepoName) => Promise<string | null>;
  dir: string;
} = {
  host: localHost,
  token: (repo) => installationTokens.get(repo),
  checkout: async (repo) => (await factoryCheckouts()).get(repo) ?? null,
  dir: tmpdir(),
};

const TOKEN_ENV = "FACTORY_GIT_TOKEN";
/** git asks this helper for the password, so the token lives in the environment and never in argv or a URL. */
const CREDENTIALS = ["-c", "credential.helper=", "-c", `credential.helper=!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV}"; }; f`];
const IDENTITY = ["-c", "user.name=marshal-factory", "-c", "user.email=marshal-factory@users.noreply.github.com"];
const KEEP_MS = 2 * 86_400_000;

const firstLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!;

type Reverted = { ok: true; url: string } | { ok: false; reason: string; url: string | null };

/** Reverts the merge on its base branch with a factory PR that merges at once; idempotent for a merged revert. */
export async function revertMerge(prUrl: string, merged: FactoryMerge, failed: readonly string[]): Promise<Reverted> {
  const { repo, number } = parsePullUrl(prUrl);
  const branch = `factory/revert-${number}`;
  const existing = await github.pullRequestForBranch(repo, branch);
  if (existing?.state === "merged") return { ok: true, url: existing.url };
  const checkout = await revertDeps.checkout(repo);
  if (!checkout) return { ok: false, reason: `This machine has no checkout of ${repo}.`, url: null };

  const { host } = revertDeps;
  const dir = join(revertDeps.dir, `marshal-factory-revert-${repo.replace("/", "-")}-${number}`);
  const git = async (args: string[], cwd = dir, env?: Record<string, string>) =>
    (await host.run("git", args, { cwd, env, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  const clean = async () => {
    await git(["worktree", "remove", "--force", dir], checkout).catch(() => "");
    if (await host.exists(dir)) await host.remove(dir);
    await git(["worktree", "prune"], checkout).catch(() => "");
    await git(["branch", "-D", branch], checkout).catch(() => "");
  };

  let url: string | null = existing?.url ?? null;
  await clean();
  try {
    await git(["fetch", "origin", merged.base], checkout);
    await git(["worktree", "add", "-B", branch, dir, `origin/${merged.base}`], checkout);
    const parents = (await git(["rev-list", "--parents", "-n", "1", merged.sha])).split(" ").length - 1;
    const target = merged.method === "rebase" && merged.commits > 1 ? [`${merged.sha}~${merged.commits}..${merged.sha}`] : parents > 1 ? ["-m", "1", merged.sha] : [merged.sha];
    try {
      await git([...IDENTITY, "revert", "--no-edit", ...target]);
    } catch (error) {
      await git(["revert", "--abort"]).catch(() => "");
      return { ok: false, reason: `git revert failed: ${firstLine(error)}`, url };
    }
    const head = await git(["rev-parse", "HEAD"]);
    const token = await revertDeps.token(repo);
    await git([...CREDENTIALS, "push", "--force", `https://github.com/${repo}.git`, `HEAD:refs/heads/${branch}`], dir, { [TOKEN_ENV]: token, GIT_TERMINAL_PROMPT: "0" });
    const title = `Revert "${merged.title}" (#${number})`;
    url ??= (
      await github.createPull(repo, {
        title,
        head: branch,
        base: merged.base,
        body: [
          `Main went red after the factory merged #${number} (${merged.sha.slice(0, 7)}).`,
          `Failed checks:\n\n${failed.map((f) => `- ${f}`).join("\n") || "- a check failed"}`,
          "Reverted by the factory.",
        ].join("\n\n"),
      })
    ).url;
    const result = await mergeRevert(url, head, merged.method, title);
    if (result.kind !== "merged") return { ok: false, reason: `GitHub didn't merge the revert: ${result.message || result.kind}`, url };
    return { ok: true, url };
  } catch (error) {
    return { ok: false, reason: firstLine(error), url };
  } finally {
    await clean();
  }
}

/** Ends the watch once: the update only lands while the job is still watching. */
async function endWatch(job: Job, decision: MergeDecision, watch: MergeWatch, detail: string, now: number) {
  const next: MergeDecision = { ...decision, watch };
  const ended = await db.transaction(async (tx) => {
    const updated = await tx
      .update(jobs)
      .set({ merge_decision: next })
      .where(and(eq(jobs.id, job.id), sql`${jobs.merge_decision}->'watch'->>'state' = 'watching'`))
      .returning({ id: jobs.id });
    if (updated.length === 0) return false;
    await auditFactory(tx, job, new Date(now), "merge_decided", decision.merged!.sha, detail);
    return true;
  });
  return ended ? next : null;
}

async function watchOne(job: Job, decision: MergeDecision & { merged: FactoryMerge; watch: MergeWatch }, now: number) {
  const { merged, watch } = decision;
  const { checks, failed } = await github.commitChecks(job.repo as RepoName, merged.sha);
  switch (checks) {
    case "success":
      return endWatch(job, decision, { ...watch, state: "green" }, "Main stayed green after the factory's merge", now);
    case "pending":
    case "none":
      if (now < Date.parse(watch.until)) return null;
      return endWatch(job, decision, { ...watch, state: "expired" }, `Main's checks didn't finish within ${config.factory.postMergeWatchMinutes} minutes of the merge; stopped watching`, now);
    case "failure": {
      const reverted = await revertMerge(job.pr_url!, merged, failed);
      const names = failed.join(", ") || "a check failed";
      return reverted.ok
        ? endWatch(job, decision, { ...watch, state: "reverted", failed, revertPr: reverted.url }, `Reverted after main went red · ${names} · ${reverted.url}`, now)
        : endWatch(job, decision, { ...watch, state: "revert_failed", failed, revertPr: reverted.url, reason: reverted.reason }, `Revert failed after main went red · ${names} · ${reverted.reason}`, now);
    }
    default: {
      const never: never = checks;
      throw new Error(`unknown check state ${String(never)}`);
    }
  }
}

/** The timer's pass over the PRs this machine merged recently; also posts any decision comment still owed. */
export async function watchMerges({ now = Date.now(), only }: { now?: number; only?: string[] } = {}) {
  const machine = await thisMachine();
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.machine_id, machine.id),
          sql`${jobs.merge_decision} ? 'merged'`,
          sql`(${jobs.merge_decision}->'merged'->>'at')::timestamptz > ${new Date(now - KEEP_MS).toISOString()}::timestamptz`,
          only ? inArray(jobs.key, only) : undefined,
        ),
      ),
  );
  const changed: string[] = [];
  const errors: { key: string; error: string }[] = [];
  for (const job of rows) {
    try {
      let decision = storedDecision(job);
      if (!decision?.merged || !decision.watch) continue;
      if (decision.watch.state === "watching") {
        const ended = await watchOne(job, { ...decision, merged: decision.merged, watch: decision.watch }, now);
        if (ended) {
          decision = ended;
          changed.push(`${job.key}:${ended.watch!.state}`);
        }
      }
      await syncComments(job, decision);
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors.length > 0 ? { changed, errors } : changed;
}
