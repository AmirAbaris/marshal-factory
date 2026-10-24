import { execFile } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { JobRow } from "../db/schema";
import { planCleanup, type BranchState } from "./cleanup";
import { attemptBranch, jobKeyFromBranch } from "./factory";

type ClaimedJob = Pick<JobRow, "key" | "attempt" | "stage" | "stage_at" | "claimed_at">;

const run = promisify(execFile);
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";
const sh = async (cmd: string, args: string[], cwd?: string) =>
  (await run(cmd, args, { cwd, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();

type Thread = { threadId: string; branch: string | null; archived: boolean; running: boolean; worktreePath: string | null };

/** Every T3 thread of the project, newest first, with the branch and worktree it is bound to. */
async function projectThreads(repo: string): Promise<Thread[]> {
  const list = z
    .array(z.object({ threadId: z.string() }))
    .parse(JSON.parse(await sh(T3, ["thread", "list", "--project", repo, "--json"])));
  return Promise.all(
    list.map(async ({ threadId }) => {
      const { thread } = z
        .object({
          thread: z.object({
            branch: z.string().nullable(),
            archived: z.boolean(),
            activeRunId: z.string().nullable(),
            worktreePath: z.string().nullable(),
          }),
        })
        .parse(JSON.parse(await sh(T3, ["thread", "show", threadId, "--json"])));
      return { threadId, branch: thread.branch, archived: thread.archived, running: thread.activeRunId !== null, worktreePath: thread.worktreePath };
    }),
  );
}

/** Linked worktrees by branch. The main checkout is listed first and never counts, whatever it has checked out. */
export async function linkedWorktrees(repo: string) {
  const out = await sh("git", ["worktree", "list", "--porcelain"], repo);
  const byBranch = new Map<string, string>();
  let path = "";
  let main = true;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (path) main = false;
      path = line.slice(9);
    }
    if (!main && line.startsWith("branch refs/heads/")) byBranch.set(line.slice(18), path);
  }
  return byBranch;
}

const prSchema = z.array(
  z.object({ state: z.string(), headRefOid: z.string(), mergedAt: z.string().nullable(), closedAt: z.string().nullable() }),
);

async function outcomeOf(repo: string, branch: string, job: ClaimedJob | undefined, head: string | null) {
  const prs = prSchema.parse(
    JSON.parse(await sh("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state,headRefOid,mergedAt,closedAt"], repo)),
  );
  const merged = prs.find((p) => p.state === "MERGED");
  const mergedAtHead = Boolean(merged && head && merged.headRefOid === head);
  // A claimed job's own stage decides; a merged PR on its branch does not end a run that is still going.
  // An earlier attempt's branch is finished once the job was claimed again.
  if (job && branch !== attemptBranch(job.key, job.attempt)) {
    return { outcome: "failed" as const, outcomeAt: job.claimed_at, mergedAtHead };
  }
  if (job) {
    const outcome = job.stage === "merged" ? "merged" : job.stage === "failed" ? "failed" : "open";
    return { outcome: outcome as "merged" | "failed" | "open", outcomeAt: job.stage_at, mergedAtHead };
  }
  if (merged) return { outcome: "merged" as const, outcomeAt: new Date(merged.mergedAt!), mergedAtHead };
  const closed = prs.find((p) => p.state === "CLOSED");
  if (closed) return { outcome: "failed" as const, outcomeAt: new Date(closed.closedAt!), mergedAtHead };
  return { outcome: prs.length ? ("open" as const) : ("unknown" as const), outcomeAt: null, mergedAtHead };
}

async function countLines(cmd: string, args: string[], cwd: string) {
  const out = await sh(cmd, args, cwd);
  return out ? out.split("\n").length : 0;
}

async function sizeKb(path: string) {
  return Number((await sh("du", ["-sk", path])).split(/\s/)[0]) || 0;
}

export type CleanupReport = {
  removed: { key: string; worktree: string | null; freedKb: number; salvagedTo?: string }[];
  held: { key: string; reason: string }[];
  /** Threads whose worktree and branch are gone; the intake pass archives them in T3. */
  archive: { key: string; threadId: string }[];
};

/**
 * Removes finished factory worktrees and local factory branches in one repo, per lib/cleanup.ts,
 * and names the T3 threads left behind so the intake pass can archive them.
 */
export async function cleanupRepo(
  repo: string,
  jobsByKey: Map<string, ClaimedJob>,
  graceDays: number,
  { now = new Date(), dryRun = false } = {},
): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], held: [], archive: [] };
  const [trees, threads, branchList] = await Promise.all([
    linkedWorktrees(repo),
    projectThreads(repo),
    sh("git", ["branch", "--list", "factory/*", "--format=%(refname:short)"], repo),
  ]);
  const localBranches = new Set(branchList ? branchList.split("\n") : []);
  const branches = new Set([...localBranches, ...trees.keys(), ...threads.flatMap((t) => (t.branch ? [t.branch] : []))]);

  const checkedOut = await sh("git", ["branch", "--show-current"], repo);
  for (const branch of branches) {
    const key = jobKeyFromBranch(branch);
    if (!key) continue;
    if (branch === checkedOut) {
      report.held.push({ key, reason: "checked out in the main repo" });
      continue;
    }
    const worktreePath = trees.get(branch) ?? null;
    const branchThreads = threads.filter(
      (t) => t.branch === branch || (worktreePath !== null && t.worktreePath === worktreePath),
    );
    const local = localBranches.has(branch);
    const head = local ? await sh("git", ["rev-parse", branch], repo) : null;
    const state: BranchState = {
      key,
      branch,
      worktreePath,
      localBranch: local,
      ...(await outcomeOf(repo, branch, jobsByKey.get(key), head)),
      dirtyFiles: worktreePath && existsSync(worktreePath) ? await countLines("git", ["status", "--porcelain"], worktreePath) : 0,
      unpushedCommits: local ? await countLines("git", ["rev-list", branch, "--not", "--remotes"], repo) : 0,
      threadRunning: branchThreads.some((t) => t.running),
    };
    const plan = planCleanup(state, now, graceDays);
    if (plan.kind === "hold") report.held.push({ key, reason: plan.reason });
    if (plan.kind === "remove" && dryRun) {
      report.removed.push({ key, worktree: worktreePath, freedKb: worktreePath && existsSync(worktreePath) ? await sizeKb(worktreePath) : 0 });
    } else if (plan.kind === "remove") {
      let freedKb = 0;
      if (worktreePath) {
        if (existsSync(worktreePath)) freedKb = await sizeKb(worktreePath);
        try {
          await sh("git", ["worktree", "remove", "--force", worktreePath], repo);
        } catch (error) {
          report.held.push({ key, reason: `git worktree remove failed: ${(error as Error).message.split("\n")[0]}` });
          continue;
        }
        // Git let go of it; ignored build output can still keep the directory alive.
        if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
        await sh("git", ["worktree", "prune"], repo);
      }
      if (local) {
        try {
          await sh("git", ["branch", "-D", branch], repo);
        } catch (error) {
          report.held.push({ key, reason: `git branch -D failed: ${(error as Error).message.split("\n")[0]}` });
          continue;
        }
      }
      report.removed.push({ key, worktree: worktreePath, freedKb });
    }
    const finished = plan.kind === "remove" || plan.reason === "already clean";
    if (finished) {
      for (const t of branchThreads) if (!t.archived) report.archive.push({ key, threadId: t.threadId });
    }
  }
  return report;
}

/** Every linked worktree with its branch, the main checkout excluded. */
async function allLinkedWorktrees(repo: string) {
  const out = await sh("git", ["worktree", "list", "--porcelain"], repo);
  const trees: { path: string; branch: string | null }[] = [];
  for (const block of out.split("\n\n").slice(1)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (path) trees.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return trees;
}

/** When git last touched the worktree: a commit, checkout or index write. */
async function lastTouched(path: string) {
  const gitDir = await sh("git", ["rev-parse", "--absolute-git-dir"], path);
  const stamps = ["index", "logs/HEAD", "HEAD"].map((f) => join(gitDir, f)).filter(existsSync).map((f) => statSync(f).mtimeMs);
  return Math.max(0, ...stamps);
}

/**
 * Claude Code puts isolated subagents in <repo>/.claude/worktrees/agent-<id> on a branch of their
 * own, and leaves them behind when the run ends early. An idle one goes the same way as a factory
 * worktree: uncommitted work holds it, and commits no remote has are first pushed to
 * factory-salvage/<branch> so removing it loses nothing.
 */
export async function cleanupSubagentWorktrees(
  repo: string,
  idleHours: number,
  { now = Date.now(), dryRun = false } = {},
): Promise<CleanupReport> {
  const report: CleanupReport = { removed: [], held: [], archive: [] };
  const root = join(repo, ".claude/worktrees") + "/";
  for (const tree of await allLinkedWorktrees(repo)) {
    if (!tree.path.startsWith(root)) continue;
    const key = tree.path.slice(root.length);
    if (!existsSync(tree.path)) continue;
    if (now - (await lastTouched(tree.path)) < idleHours * 3_600_000) {
      report.held.push({ key, reason: "touched within the idle window; a subagent may still use it" });
      continue;
    }
    const dirty = await countLines("git", ["status", "--porcelain"], tree.path);
    if (dirty > 0) {
      report.held.push({ key, reason: `${dirty} uncommitted files` });
      continue;
    }
    const unique = await countLines("git", ["rev-list", "HEAD", "--not", "--remotes"], tree.path);
    const freedKb = await sizeKb(tree.path);
    if (dryRun) {
      report.removed.push({ key, worktree: tree.path, freedKb });
      continue;
    }
    let salvagedTo: string | undefined;
    if (unique > 0) {
      const salvage = `factory-salvage/${tree.branch ?? key}`;
      try {
        await sh("git", ["push", "origin", `HEAD:refs/heads/${salvage}`], tree.path);
      } catch (error) {
        report.held.push({ key, reason: `push to ${salvage} failed: ${(error as Error).message.split("\n")[0]}` });
        continue;
      }
      const remote = await sh("git", ["ls-remote", "origin", `refs/heads/${salvage}`], repo);
      const head = await sh("git", ["rev-parse", "HEAD"], tree.path);
      if (!remote.startsWith(head)) {
        report.held.push({ key, reason: `push to ${salvage} not confirmed` });
        continue;
      }
      salvagedTo = `origin/${salvage}`;
    }
    try {
      await sh("git", ["worktree", "remove", "--force", tree.path], repo);
    } catch (error) {
      report.held.push({ key, reason: `git worktree remove failed: ${(error as Error).message.split("\n")[0]}` });
      continue;
    }
    if (existsSync(tree.path)) rmSync(tree.path, { recursive: true, force: true });
    await sh("git", ["worktree", "prune"], repo);
    if (tree.branch) {
      await sh("git", ["branch", "-D", tree.branch], repo).catch((error: Error) =>
        report.held.push({ key, reason: `worktree removed, but git branch -D ${tree.branch} failed: ${error.message.split("\n")[0]}` }),
      );
    }
    report.removed.push({ key, worktree: tree.path, freedKb, salvagedTo });
  }
  return report;
}
