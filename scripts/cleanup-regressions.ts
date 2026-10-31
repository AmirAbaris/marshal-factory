import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCleanup, type BranchState } from "../lib/cleanup";
import { attemptBranch, parseBranch } from "../lib/factory";

// A T3 CLI with no threads; the cleanup modules read the path when they load.
const t3Dir = mkdtempSync(join(tmpdir(), "cleanup-t3-"));
process.env.T3CODE_CLI_PATH = join(t3Dir, "t3");
writeFileSync(process.env.T3CODE_CLI_PATH, "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
const { cleanupRepo, linkedWorktrees } = await import("../lib/worktrees");
const { github } = await import("../lib/github/pulls");
const ops = await import("../runner/ops");
const { reconcile } = await import("../runner/reconcile");

const now = new Date("2026-10-23T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const merged: BranchState = {
  key: "FAC-9",
  branch: "factory/FAC-9",
  worktreePath: "/tmp/wt",
  localBranch: true,
  outcome: "merged",
  outcomeAt: daysAgo(0),
  dirtyFiles: 0,
  unpushedCommits: 0,
  mergedAtHead: false,
  threadRunning: false,
};

assert.deepEqual(planCleanup(merged, now, 3), { kind: "remove" }, "merged and clean goes right away");
assert.equal(planCleanup({ ...merged, outcome: "open" }, now, 3).kind, "skip", "open work is never touched");
assert.equal(planCleanup({ ...merged, outcome: "unknown" }, now, 3).kind, "skip");
assert.equal(planCleanup({ ...merged, outcome: "failed", outcomeAt: daysAgo(1) }, now, 3).kind, "skip", "failed waits out the grace period");
assert.deepEqual(planCleanup({ ...merged, outcome: "failed", outcomeAt: daysAgo(4) }, now, 3), { kind: "remove" });
assert.deepEqual(planCleanup({ ...merged, dirtyFiles: 2 }, now, 3), { kind: "hold", reason: "2 uncommitted files" }, "uncommitted work is held");
assert.deepEqual(planCleanup({ ...merged, unpushedCommits: 1 }, now, 3), { kind: "hold", reason: "1 unpushed commits" }, "unpushed work is held");
assert.deepEqual(planCleanup({ ...merged, unpushedCommits: 1, mergedAtHead: true }, now, 3), { kind: "remove" }, "a head the PR merged is safe");
assert.equal(planCleanup({ ...merged, threadRunning: true }, now, 3).kind, "hold", "a running thread keeps its worktree");
assert.deepEqual(planCleanup({ ...merged, worktreePath: null, localBranch: false }, now, 3), { kind: "skip", reason: "already clean" });

assert.equal(parseBranch("factory/FAC-5")?.key, "FAC-5");
assert.equal(parseBranch(attemptBranch("FAC-5", 2))?.key, "FAC-5", "a retry branch maps back to its job");
assert.equal(attemptBranch("FAC-5", 1), "factory/FAC-5");
assert.equal(parseBranch("worktree-agent-abc")?.key, undefined);

// Resolved, as git reports worktree paths: tmpdir is a symlink on macOS.
const dir = realpathSync(mkdtempSync(join(tmpdir(), "cleanup-")));
try {
  const gitIn = (repo: string) => (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "pipe", encoding: "utf8" }).trim();
  const git = gitIn(join(dir, "main"));
  execFileSync("git", ["init", "-q", "-b", "factory/TST-1", join(dir, "main")]);
  git("commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "factory/TST-2", join(dir, "wt"));
  const trees = await linkedWorktrees(join(dir, "main"));
  assert.deepEqual([...trees.keys()], ["factory/TST-2"], "the main checkout is never a cleanup candidate, whatever its branch");

  // Two finished branches; GitHub fails for one of them.
  const repo = join(dir, "repo");
  const inRepo = gitIn(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  inRepo("commit", "-q", "--allow-empty", "-m", "init");
  inRepo("remote", "add", "origin", "https://github.com/o/r.git");
  for (const key of ["TST-3", "TST-4"]) {
    inRepo("checkout", "-q", "-b", `factory/${key}`, "main");
    inRepo("commit", "-q", "--allow-empty", "-m", key);
  }
  inRepo("checkout", "-q", "main");
  const mergedHead = inRepo("rev-parse", "factory/TST-4");
  const remoteDeletes: string[] = [];
  (github as unknown as { deleteBranch: (r: string, b: string) => Promise<boolean> }).deleteBranch = async (r: string, b: string) => {
    remoteDeletes.push(`${r}:${b}`);
    return true;
  };
  github.pullsForHead = async (_, branch) => {
    if (branch === "factory/TST-3") throw new Error("GitHub GET /repos/o/r/pulls answered 502");
    return [{ state: "merged", headSha: mergedHead, mergedAt: now, closedAt: now }];
  };
  const report = await cleanupRepo(repo, new Map(), 3, { now });
  assert.deepEqual(report.removed.map((r) => r.key), ["TST-4"], "a branch GitHub fails for does not stop the next one from being cleaned");
  assert.deepEqual(report.held, [{ key: "TST-3", reason: "cleanup failed: GitHub GET /repos/o/r/pulls answered 502" }], "it is held with the error");
  assert.equal(inRepo("branch", "--list", "factory/*", "--format=%(refname:short)"), "factory/TST-3", "only the merged branch is deleted");
  assert.deepEqual(remoteDeletes, ["o/r:factory/TST-4"], "the merged branch is also deleted from GitHub");

  // A repo cleanup cannot read still gets its idle subagent worktrees looked at.
  const other = join(dir, "other");
  const inOther = gitIn(other);
  execFileSync("git", ["init", "-q", "-b", "main", other]);
  inOther("commit", "-q", "--allow-empty", "-m", "init");
  inOther("remote", "add", "origin", "https://gitlab.com/o/r.git");
  inOther("worktree", "add", "-q", "-b", "agent-1", join(other, ".claude/worktrees/agent-1"));
  ops.config.factory.repos = [other];
  const cleaned = await ops.cleanup(true);
  assert.deepEqual(cleaned.errors, [{ repo: other, step: "factory", error: `${other} has no GitHub origin` }], "the factory cleanup's error is reported");
  assert.deepEqual(cleaned.held, [{ key: "agent-1", reason: "touched within the idle window; a subagent may still use it" }], "and the subagent cleanup still ran");

  let launched = false;
  const started = await reconcile({
    tick: async () => ({ claimed: 1 }),
    cleanup: async () => {
      throw new Error("GitHub down");
    },
    launch: async () => {
      launched = true;
      return ["TST-5"];
    },
  });
  assert.ok(launched, "a failed cleanup does not keep the startup pass from launching");
  assert.deepEqual(started, { claimed: 1, cleaned: { error: "GitHub down" }, launched: ["TST-5"] });
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(t3Dir, { recursive: true, force: true });
}

console.log("cleanup regressions passed");
process.exit(0);
