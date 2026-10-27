import type { JobRow, RunRow } from "@/db/schema";
import type { Stage } from "@/lib/events";
import { sandboxState, type SandboxState } from "@/lib/execution";
import { attemptBranch } from "@/lib/factory";
import { harnessLabel, isTracked, type Harness } from "@/lib/harness";
import { mergeDecisionSchema, type MergeDecision } from "@/lib/merge-decision";
import { sourceLink } from "@/lib/sources/shapes";
import { groupBy } from "./format";

/** One board card: a claimed job, or a staged run whose job the factory never claimed. */
export type BoardCard = {
  id: string;
  jobKey: string | null;
  title: string;
  stage: Stage;
  summary: string | null;
  question: string | null;
  prUrl: string | null;
  sourceLink: { label: string; href: string } | null;
  budgetUsd: number | null;
  machineId: string | null;
  answeredAt: Date | null;
  attempt: number;
  /** The runs of the current attempt; spend against the cap counts only these. */
  attemptRuns: RunRow[];
  /** Set while the watchdog's nudge for the current stage is outstanding. */
  nudgedAt: Date | null;
  /** The run the card opens; null while a claimed job has no session yet. */
  latest: RunRow | null;
  runs: RunRow[];
  /** The harness the current attempt launched on; null before a launch. */
  harness: CardHarness | null;
  /** Where the current attempt runs; null before a launch. */
  runsOn: RunsOn | null;
  /** The runner's merge decision while the job is in pr, or once the factory merged it. */
  mergeDecision: MergeDecision | null;
  /** The newest change to the job or any of its runs. */
  updatedAt: Date;
};

/** Untracked harnesses report no stages or cost, so the card says so. */
export type CardHarness = { name: string; tracked: boolean };

export type RunsOn = { kind: "modal"; sandbox: SandboxState | null } | { kind: "local"; machineId: string };

export function runsOn(job: Pick<JobRow, "execution" | "machine_id" | "sandbox_id" | "sandbox_snapshot">): RunsOn | null {
  const sandbox = sandboxState(job);
  if (job.execution === "modal" || sandbox) return { kind: "modal", sandbox };
  return job.machine_id ? { kind: "local", machineId: job.machine_id } : null;
}

export function whereLine(where: RunsOn, machineName: string | null) {
  switch (where.kind) {
    case "modal":
      return "Modal sandbox";
    case "local":
      return `Local · ${machineName ?? where.machineId}`;
    default: {
      const never: never = where;
      throw new Error(`unknown place ${String(never)}`);
    }
  }
}

export const harnessLine = (harness: CardHarness) => (harness.tracked ? harness.name : `${harness.name} · not tracked`);

/** A tracked job in pr waits on a merge decision; a merged one shows the factory's watch on main. */
export const showsDecision = (card: Pick<BoardCard, "stage" | "sourceLink" | "mergeDecision">) =>
  (card.stage === "pr" && card.sourceLink !== null) || card.mergeDecision?.merged !== undefined;

/** The decision a job shows: while in pr, and after a merge the factory made, for its watch on main. */
export function shownDecision(job: Pick<JobRow, "stage" | "merge_decision">): MergeDecision | null {
  const decision = mergeDecisionSchema.safeParse(job.merge_decision).data ?? null;
  return job.stage === "pr" || (job.stage === "merged" && decision?.merged) ? decision : null;
}

const stagedAt = (run: RunRow) => run.stage_at?.getTime() ?? 0;

/** `harnesses` are the ones the machines report, so a renamed Claude Code instance keeps its name and stays tracked. */
export function boardCards(jobs: readonly JobRow[], runs: readonly RunRow[], harnesses: readonly Harness[] = []): BoardCard[] {
  const harnessOf = (provider: string): CardHarness => {
    const known = harnesses.find((h) => h.id === provider);
    return { name: known?.name ?? harnessLabel(provider), tracked: isTracked(known?.driver ?? provider) };
  };
  const byKey = groupBy(
    runs.filter((r) => r.job_key !== null),
    (r) => r.job_key!,
  );
  const newestFirst = (rows: readonly RunRow[]) =>
    [...rows].sort((a, b) => stagedAt(b) - stagedAt(a));

  const fromJobs = jobs.map((job): BoardCard => {
    const jobRuns = newestFirst(byKey.get(job.key) ?? []);
    const attemptRuns = jobRuns.filter((r) => r.branch === attemptBranch(job.key, job.attempt));
    return {
      id: job.key,
      jobKey: job.key,
      title: job.title,
      stage: job.stage,
      summary: job.stage_summary,
      question: job.question,
      prUrl: job.pr_url,
      sourceLink: sourceLink(job),
      budgetUsd: job.budget_usd,
      machineId: job.machine_id,
      answeredAt: job.answered_at,
      attempt: job.attempt,
      attemptRuns,
      nudgedAt: job.nudged_stage === job.stage ? job.nudged_at : null,
      latest: attemptRuns.find((r) => r.session_id === job.session_id) ?? attemptRuns[0] ?? null,
      runs: jobRuns,
      harness: job.provider ? harnessOf(job.provider) : null,
      runsOn: runsOn(job),
      mergeDecision: shownDecision(job),
      updatedAt: new Date(Math.max(job.updated_at.getTime(), ...jobRuns.map((r) => r.last_event_at.getTime()))),
    };
  });

  const claimed = new Set(jobs.map((j) => j.key));
  const unclaimed = runs.filter(
    (r): r is RunRow & { stage: Stage } =>
      r.stage !== null && !(r.job_key && claimed.has(r.job_key)),
  );
  const fromRuns = [...groupBy(unclaimed, (r) => r.job_key ?? r.session_id).entries()].map(
    ([id, group]): BoardCard => {
      const sorted = newestFirst(group);
      const latest = sorted[0]! as RunRow & { stage: Stage };
      return {
        id,
        jobKey: latest.job_key,
        title: latest.title ?? latest.job_key ?? "Factory run",
        stage: latest.stage,
        summary: latest.stage_summary,
        question: latest.question,
        prUrl: sorted.find((r) => r.pr_url)?.pr_url ?? null,
        sourceLink: null,
        budgetUsd: null,
        machineId: null,
        answeredAt: null,
        attempt: 1,
        attemptRuns: sorted,
        nudgedAt: null,
        latest,
        runs: sorted,
        harness: null,
        runsOn: null,
        mergeDecision: null,
        updatedAt: new Date(Math.max(...sorted.map((r) => r.last_event_at.getTime()))),
      };
    },
  );
  return [...fromJobs, ...fromRuns];
}
