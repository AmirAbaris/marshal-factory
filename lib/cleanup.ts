/** What the factory knows about one factory/<KEY> branch in a target repo. */
export type BranchState = {
  key: string;
  branch: string;
  worktreePath: string | null;
  localBranch: boolean;
  /** Merged and failed end the work; failed covers a closed PR and a job the factory gave up on. */
  outcome: "merged" | "failed" | "open" | "unknown";
  outcomeAt: Date | null;
  /** Tracked or untracked changes in the worktree; ignored files such as node_modules do not count. */
  dirtyFiles: number;
  /** Commits on the branch that no remote ref contains. */
  unpushedCommits: number;
  /** The PR merged with exactly this head, so its commits are safe even if the remote branch is gone. */
  mergedAtHead: boolean;
  threadRunning: boolean;
};

export type CleanupPlan =
  | { kind: "skip"; reason: string }
  | { kind: "hold"; reason: string }
  | { kind: "remove" };

const DAY_MS = 86_400_000;

/** Only finished work goes. A worktree with anything that exists nowhere else is held and reported. */
export function planCleanup(state: BranchState, now: Date, graceDays: number): CleanupPlan {
  if (state.outcome === "open" || state.outcome === "unknown") return { kind: "skip", reason: state.outcome };
  if (state.outcome === "failed" && now.getTime() - (state.outcomeAt?.getTime() ?? now.getTime()) < graceDays * DAY_MS) {
    return { kind: "skip", reason: "failed within the grace period" };
  }
  if (!state.worktreePath && !state.localBranch) return { kind: "skip", reason: "already clean" };
  if (state.threadRunning) return { kind: "hold", reason: "its thread is running" };
  if (state.dirtyFiles > 0) return { kind: "hold", reason: `${state.dirtyFiles} uncommitted files` };
  if (state.unpushedCommits > 0 && !state.mergedAtHead) {
    return { kind: "hold", reason: `${state.unpushedCommits} unpushed commits` };
  }
  return { kind: "remove" };
}
