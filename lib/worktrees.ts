import { execFile } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { IssueRow } from "../db/schema";
import { planCleanup, type BranchState } from "./cleanup";
import { issueKeyFromBranch } from "./factory";

const run = promisify(execFile);
const T3 = process.env.T3CODE_CLI_PATH ?? join(homedir(), ".t3/bin/t3");
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

async function outcomeOf(repo: string, branch: string, issue: IssueRow | undefined, head: string | null) {
  const prs = prSchema.parse(
    JSON.parse(await sh("gh", ["pr", "list", "--head", branch, "--state", "all", "--json", "state,headRefOid,mergedAt,closedAt"], repo)),
  );
  const merged = prs.find((p) => p.state === "MERGED");
  const mergedAtHead = Boolean(merged && head && merged.headRefOid === head);
  // A claimed issue's own stage decides; a merged PR on its branch does not end a run that is still going.
  if (issue) {
    const outcome = issue.stage === "merged" ? "merged" : issue.stage === "failed" ? "failed" : "open";
    return { outcome: outcome as "merged" | "failed" | "open", outcomeAt: issue.stage_at, mergedAtHead };
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
  removed: { key: string; worktree: string | null; freedKb: number }[];
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
  issuesByKey: Map<string, IssueRow>,
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

  for (const branch of branches) {
    const key = issueKeyFromBranch(branch);
    if (!key) continue;
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
      ...(await outcomeOf(repo, branch, issuesByKey.get(key), head)),
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
      if (local) await sh("git", ["branch", "-D", branch], repo);
      report.removed.push({ key, worktree: worktreePath, freedKb });
    }
    const finished = plan.kind === "remove" || plan.reason === "already clean";
    if (finished) {
      for (const t of branchThreads) if (!t.archived) report.archive.push({ key, threadId: t.threadId });
    }
  }
  return report;
}
