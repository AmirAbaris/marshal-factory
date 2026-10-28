import type { JobRow } from "../db/schema";
import type { Stage } from "./events";
import { isStopPending, parseStop, stopNeedsOwner } from "./stop";

// The owner archives finished jobs off the jobs page, the inbox and their counts. It is the panel's
// view only: the runner, ingest, the source and GitHub never read it. Pure, so the panel, the
// actions and the regressions share the rules.

export const FINISHED_STAGES = ["merged", "failed"] as const satisfies readonly Stage[];

export const isFinished = (stage: Stage) => (FINISHED_STAGES as readonly Stage[]).includes(stage);

export type ArchiveJob = Pick<JobRow, "stage" | "stage_at" | "updated_at" | "archived_at" | "stop" | "dismissed_at">;

/** An archive hides the finished job it saw; a job reclaimed or moved on since shows again. */
export const isArchived = (job: Pick<JobRow, "stage" | "stage_at" | "updated_at" | "archived_at">) =>
  job.archived_at !== null && isFinished(job.stage) && job.archived_at.getTime() >= (job.stage_at ?? job.updated_at).getTime();

/** Why the job can't be archived, or null when it can. A stop still on its way may leave an agent running. */
export function archiveRefusal(job: ArchiveJob): string | null {
  if (!isFinished(job.stage)) return "Only merged or failed jobs can be archived.";
  if (isStopPending(parseStop(job.stop)) || stopNeedsOwner(job.stop, job.dismissed_at)) return "The job's stop isn't confirmed yet.";
  return null;
}

/** The jobs the panel shows outside the archive, and the archived ones. */
export function splitArchived<J extends Pick<JobRow, "stage" | "stage_at" | "updated_at" | "archived_at">>(jobs: readonly J[]) {
  const shown: J[] = [];
  const archived: J[] = [];
  for (const job of jobs) (isArchived(job) ? archived : shown).push(job);
  return { shown, archived };
}
