import type { JobRow } from "../db/schema";
import type { Stage } from "./events";
import { attemptBranch } from "./factory";

export const RUNNER_CAUSES = ["resume", "conflict", "merged", "watchdog", "budget", "stop", "closed", "reclaim"] as const;
export type RunnerCause = (typeof RUNNER_CAUSES)[number];
export type Cause = "report" | RunnerCause;

export const runnerEventId = (cause: RunnerCause, ...parts: (string | number)[]) => [cause, ...parts].join(":");

export function causeOf(eventId: string): Cause {
  const prefix = eventId.slice(0, eventId.indexOf(":"));
  return (RUNNER_CAUSES as readonly string[]).includes(prefix) ? (prefix as RunnerCause) : "report";
}

const REPORTED = ["triage", "investigating", "implementing", "verifying", "pr", "waiting", "failed"] as const;
const FROM_WORKING = { report: REPORTED, watchdog: ["failed"], budget: ["failed"], stop: ["failed"], merged: ["merged"] } as const;

export const STAGE_TRANSITIONS: { readonly [From in Stage]: { readonly [C in Cause]?: readonly Stage[] } } = {
  queued: FROM_WORKING,
  triage: FROM_WORKING,
  investigating: FROM_WORKING,
  implementing: FROM_WORKING,
  verifying: FROM_WORKING,
  pr: { report: REPORTED, conflict: ["implementing", "failed"], stop: ["failed"], merged: ["merged"] },
  waiting: { report: REPORTED, resume: ["queued"], closed: ["failed"], stop: ["failed"], merged: ["merged"] },
  merged: {},
  failed: { reclaim: ["queued"], merged: ["merged"] },
};

export const canTransition = (from: Stage, to: Stage, cause: Cause) =>
  STAGE_TRANSITIONS[from][cause]?.includes(to) ?? false;

export type StageRow = Pick<JobRow, "key" | "stage" | "stage_at" | "attempt" | "stage_event_id">;
export type StageMove = { stage: Stage; at: Date; eventId: string; branch?: string };

export type StageVerdict =
  | { apply: true; cause: Cause }
  | { apply: false; cause: Cause; reason: "already applied" | "stale" | "earlier attempt" | "forbidden" };

export function decideStage(row: StageRow, move: StageMove): StageVerdict {
  const cause = causeOf(move.eventId);
  if (row.stage_event_id === move.eventId) return { apply: false, cause, reason: "already applied" };
  if (row.stage_at && move.at < row.stage_at) return { apply: false, cause, reason: "stale" };
  if (move.branch && move.branch !== attemptBranch(row.key, row.attempt)) return { apply: false, cause, reason: "earlier attempt" };
  if (!canTransition(row.stage, move.stage, cause)) return { apply: false, cause, reason: "forbidden" };
  return { apply: true, cause };
}
