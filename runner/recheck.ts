/**
 * After a push to main GitHub reports mergeability as UNKNOWN for a while. Instead of waiting on
 * the runner's serial queue, a recheck polls in short queued steps on a timer until the open
 * factory PRs have settled or the deadline passes, then runs the conflict check once. Requests
 * that arrive while one is pending only extend its deadline, so a burst of pushes runs one check.
 */
export type RecheckDeps = {
  /** True when no open factory PR is still UNKNOWN. One short GitHub round. */
  settled: () => Promise<boolean>;
  /** The idempotent conflict check. */
  check: () => Promise<unknown>;
  /** Runs a step on the runner's serial queue. */
  enqueue: (name: string, step: () => Promise<unknown>) => void;
  schedule: (run: () => void, ms: number) => void;
  now: () => number;
};

export function recheckScheduler(deps: RecheckDeps, { waitMs = 120_000, pollMs = 5_000 } = {}) {
  let deadline: number | undefined;

  // A failed GitHub round counts as not settled, so the next step retries it.
  const settled = () => deps.settled().catch(() => false);

  const step = async () => {
    if (deadline === undefined) return "idle";
    if (!(await settled()) && deps.now() < deadline) {
      deps.schedule(() => deps.enqueue("recheck", step), pollMs);
      return "waiting for GitHub";
    }
    // Reset before the check, so a throwing check cannot leave a recheck stuck as pending.
    deadline = undefined;
    return deps.check();
  };

  return {
    /** Returns at once; the check runs later from the queue. */
    request() {
      const first = deadline === undefined;
      deadline = deps.now() + waitMs;
      if (first) deps.schedule(() => deps.enqueue("recheck", step), 0);
      return first ? "scheduled" : "already scheduled";
    },
  };
}
