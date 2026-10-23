import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planCleanup, type BranchState } from "../lib/cleanup";
import { linkedWorktrees } from "../lib/worktrees";

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

const dir = mkdtempSync(join(tmpdir(), "cleanup-"));
try {
  const git = (...args: string[]) => execFileSync("git", ["-C", join(dir, "main"), ...args], { stdio: "pipe" });
  execFileSync("git", ["init", "-q", "-b", "factory/TST-1", join(dir, "main")]);
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  git("worktree", "add", "-q", "-b", "factory/TST-2", join(dir, "wt"));
  const trees = await linkedWorktrees(join(dir, "main"));
  assert.deepEqual([...trees.keys()], ["factory/TST-2"], "the main checkout is never a cleanup candidate, whatever its branch");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("cleanup regressions passed");
