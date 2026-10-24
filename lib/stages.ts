import type { JobRow } from "../db/schema";
import type { Stage } from "./events";
import { attemptBranch } from "./factory";

/** What the runner itself moves a stage for. Its stage events carry the cause as their id prefix. */
export const RUNNER_CAUSES = ["resume", "conflict", "merged", "watchdog", "budget", "stop", "closed", "reclaim"] as const;
export type RunnerCause = (typeof RUNNER_CAUSES)[number];
/** `report` is a thread's own report_stage call; every other cause is the runner's. */
export type Cause = "report" | RunnerCause;

/** The id of a stage event the runner records; the prefix is how ingest tells its cause. */
export const runnerEventId = (cause: RunnerCause, ...parts: (string | number)[]) => [cause, ...parts].join(":");

export function causeOf(eventId: string): Cause {
  const prefix = eventId.slice(0, eventId.indexOf(":"));
  return (RUNNER_CAUSES as readonly string[]).includes(prefix) ? (prefix as RunnerCause) : "report";
}

/** Threads skip and repeat stages, so a report may move between any of these. */
const REPORTED = ["triage", "investigating", "implementing", "verifying", "pr", "waiting", "failed"] as const;
/** A thread that is working, or about to be. The watchdog and the budget backstop watch these. */
const WORKING = { report: REPORTED, watchdog: ["failed"], budget: ["failed"], stop: ["failed"], merged: ["merged"] } as const;

/**
 * Every stage change a job may make, by the stage it leaves and what caused it. Ingest and the
 * runner's stop decide through canTransition; scripts/stage-history-check.ts replays history through it.
 */
export const STAGE_TRANSITIONS: { readonly [From in Stage]: { readonly [C in Cause]?: readonly Stage[] } } = {
  queued: WORKING,
  triage: WORKING,
  investigating: WORKING,
  implementing: WORKING,
  verifying: WORKING,
  pr: { report: REPORTED, conflict: ["implementing", "failed"], stop: ["failed"], merged: ["merged"] },
  waiting: { report: REPORTED, resume: ["queued"], closed: ["failed"], stop: ["failed"], merged: ["merged"] },
  merged: {},
  // A failed attempt only ever becomes a new attempt, or merged when a human merges its PR anyway.
  failed: { reclaim: ["queued"], merged: ["merged"] },
};

export const canTransition = (from: Stage, to: Stage, cause: Cause) =>
  STAGE_TRANSITIONS[from][cause]?.includes(to) ?? false;

export type StageRow = Pick<JobRow, "key" | "stage" | "stage_at" | "attempt" | "stage_event_id">;
export type StageMove = { stage: Stage; at: Date; eventId: string; branch?: string };

export type StageVerdict =
  | { apply: true; cause: Cause }
  | { apply: false; cause: Cause; reason: "already applied" | "stale" | "earlier attempt" | "forbidden" };

/**
 * Whether a stage event moves the job. Stage reports apply in stage_at order; a thread's report
 * counts only on the job's current attempt branch; the transition must be in the table. The
 * runner records some stages on the row before posting their event, which then changes nothing.
 */
export function decideStage(row: StageRow, move: StageMove): StageVerdict {
  const cause = causeOf(move.eventId);
  if (row.stage_event_id === move.eventId) return { apply: false, cause, reason: "already applied" };
  if (row.stage_at && move.at < row.stage_at) return { apply: false, cause, reason: "stale" };
  if (move.branch && move.branch !== attemptBranch(row.key, row.attempt)) return { apply: false, cause, reason: "earlier attempt" };
  if (!canTransition(row.stage, move.stage, cause)) return { apply: false, cause, reason: "forbidden" };
  return { apply: true, cause };
}
