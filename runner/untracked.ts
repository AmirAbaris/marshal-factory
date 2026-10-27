import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "../db/client";
import { jobs } from "../db/schema";
import type { Stage } from "../lib/events";
import { attemptBranch } from "../lib/factory";
import type { RepoName } from "../lib/github/app";
import { github } from "../lib/github/pulls";
import { hosts, isHibernated } from "../lib/host";
import { parseJobs } from "../lib/sources";
import type { Job } from "../lib/sources/types";
import { causeOf, runnerEventId } from "../lib/stages";
import { bindingOf } from "./binding";
import { thisMachine } from "./heartbeat";
import { config, harnessDrivers, IN_FLIGHT, jobTracked, postEvent, postMerged, threads, watchdogFail } from "./ops";

// A harness that runs no factory hooks (Codex, Cursor, ...) reports no usage, and stages only
// through the factory-report MCP server where it has one, so the runner fills the gaps from what it
// left behind: a PR on the attempt branch moves the job to pr (or merged),
// and a thread that settled without one moves it to waiting with its last message as the question.
// A job sent back for a conflict already has its PR; once its thread settles it is back in pr.
// Every event id names the stage it leaves, so a repeated pass posts nothing new.

type Settled = "completed" | "interrupted" | "failed";

/** T3's run statuses for a thread with no active run. */
const settledAs = (status: string | null): Settled =>
  status === "failed" ? "failed" : status === "interrupted" || status === "cancelled" || status === "rolled_back" ? "interrupted" : "completed";

const SECRET = /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})/g;

/** The thread's last message as a question: tokens masked, cut to what a stage report takes. */
export function questionFrom(message: string | null, settled: Exclude<Settled, "failed">) {
  const text = message?.replace(SECRET, "[redacted]").trim();
  const fallback = `The thread ${settled === "completed" ? "finished" : "was interrupted"} without opening a pull request. How should it go on?`;
  if (!text) return fallback;
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

const sessionOf = (job: Job) => job.session_id ?? runnerEventId("inferred", job.external_id, job.attempt);

async function post(job: Job, stage: Extract<Stage, "pr" | "waiting">, fields: { summary: string; prUrl?: string; question?: string }) {
  await postEvent({
    eventId: runnerEventId("inferred", job.external_id, job.attempt, stage, job.stage_event_id ?? job.stage),
    sessionId: sessionOf(job),
    at: Date.now(),
    kind: "stage",
    stage,
    jobKey: job.key,
    ...fields,
  });
}

async function inferJob(job: Job, now: number): Promise<string | undefined> {
  // A thread that was just launched, resumed or sent back may not have started its run yet.
  const quiet = now - (job.stage_at ?? job.updated_at).getTime() >= config.factory.stoppedGraceMinutes * 60_000;
  // A stage the agent reported itself (Codex through the factory-report server) stands until the
  // run has been quiet past the grace, so its own pr report, with its assessment, comes first.
  const reported = job.stage_event_id !== null && causeOf(job.stage_event_id) === "report";
  if (!job.pr_url && (quiet || !reported)) {
    const pr = await github.pullRequestForBranch(job.repo as RepoName, attemptBranch(job.key, job.attempt));
    if (pr?.state === "merged") {
      await postMerged(job.key, pr.url, job.session_id ?? runnerEventId("merged", job.external_id));
      return "merged";
    }
    if (pr?.state === "open") {
      await post(job, "pr", { summary: `Opened ${pr.url}`, prUrl: pr.url });
      return "pr";
    }
  }
  if (!quiet) return undefined;
  const thread = await threads.read(job.t3_thread_id, hosts.forJob(job));
  // A gone thread is the watchdog's to fail.
  if (thread.state !== "stopped") return undefined;
  const settled = settledAs(thread.status);
  switch (settled) {
    case "failed":
      return (await watchdogFail(job, `its T3 thread failed (stage ${job.stage})`)) ? "failed" : undefined;
    case "completed":
    case "interrupted":
      if (job.pr_url) {
        await post(job, "pr", { summary: `The thread settled after the conflict send-back; ${job.pr_url} is up for review again.`, prUrl: job.pr_url });
        return "pr";
      }
      await post(job, "waiting", {
        summary: `The thread ${settled === "completed" ? "finished" : "was interrupted"} without opening a pull request.`,
        question: questionFrom(thread.lastMessage, settled),
      });
      return "waiting";
    default: {
      const never: never = settled;
      throw new Error(`unknown thread outcome ${String(never)}`);
    }
  }
}

/**
 * The timer's pass over this machine's working jobs on untracked harnesses. A hibernated job is
 * never woken for it. Each job on its own, so one GitHub or T3 failure does not hold back the rest.
 */
export async function inferUntracked({ now = Date.now(), only }: { now?: number; only?: string[] } = {}) {
  const machine = await thisMachine();
  const rows = parseJobs(
    await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.machine_id, machine.id), inArray(jobs.stage, IN_FLIGHT), isNotNull(jobs.t3_thread_id), only ? inArray(jobs.key, only) : undefined)),
  );
  const drivers = harnessDrivers();
  const done: string[] = [];
  const errors: { key: string; error: string }[] = [];
  for (const job of rows) {
    if (jobTracked(job, drivers) || bindingOf(job.t3_thread_id) !== "bound" || isHibernated(job)) continue;
    try {
      const outcome = await inferJob(job, now);
      if (outcome) done.push(`${job.key}:${outcome}`);
    } catch (error) {
      errors.push({ key: job.key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return errors.length > 0 ? { done, errors } : done;
}
