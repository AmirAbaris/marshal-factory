import { and, isNotNull, sql } from "drizzle-orm";
import { jobs, type JobRow } from "../db/schema";
import { isStopPending, parseStop, PENDING_STOP_STATES, stopNeedsOwner } from "../lib/stop";

// How a job relates to its T3 thread, and when a stop is still owed to it.
//
//   binding   t3_thread_id is null (none), a `pending:` launch marker, or a real thread id (bound)
//   stopped   a stop was recorded for this attempt (stop_event_id, which starts with `stop:`); a later
//             stage such as a merge leaves it, so a stop owed to a thread that is still running is sent
//   owed      stopped, and either a launch is pending (its thread may still appear) or the bound
//             thread is not the one stop_sent_to names
//   stopping  the stop is not confirmed yet (lib/stop.ts): the job keeps its launch capacity
//   held      the stop was marked unconfirmed and the owner has not dismissed it since: the old
//             thread may still run, so no new attempt starts
//
// A stop is delivered only to a bound thread. Every runner binding goes through bindThread, which
// delivers an owed stop right after it binds; a binding made by ingest (the thread's own session
// start) is caught by the runner's jobs subscription and its timer. A new attempt is refused
// while any launch is pending, a stop is owed, stopping or held, and while the failed attempt
// still holds a sandbox, snapshot or login slot that teardown has not handed back.

type Row = Pick<JobRow, "stage" | "stop_event_id" | "t3_thread_id" | "stop_sent_to">;
type StopRow = Partial<Pick<JobRow, "stop" | "dismissed_at">>;
type ReclaimRow = Row & StopRow & Pick<JobRow, "sandbox_id" | "sandbox_snapshot" | "codex_slot">;

export const PENDING = "pending:";

export function bindingOf(threadId: string | null) {
  if (!threadId) return "none";
  return threadId.startsWith(PENDING) ? "pending" : "bound";
}

export const isStopped = (i: Row) => Boolean(i.stop_event_id?.startsWith("stop:"));

export function stopOwed(i: Row) {
  if (!isStopped(i)) return false;
  const binding = bindingOf(i.t3_thread_id);
  return binding === "pending" || (binding === "bound" && i.stop_sent_to !== i.t3_thread_id);
}

export const stopDeliverable = (i: Row) => stopOwed(i) && bindingOf(i.t3_thread_id) === "bound";

export const stopping = (i: StopRow) => isStopPending(parseStop(i.stop));

export const stopHeld = (i: StopRow) => stopNeedsOwner(i.stop, i.dismissed_at);

const holdsSandbox = (i: ReclaimRow) => Boolean(i.sandbox_id || i.sandbox_snapshot || i.codex_slot);

export const canReclaim = (i: ReclaimRow) =>
  i.stage === "failed" && bindingOf(i.t3_thread_id) !== "pending" && !stopOwed(i) && !holdsSandbox(i) && !stopping(i) && !stopHeld(i);

// The same rules as SQL, for the queries that claim rows. scripts/launch-regressions.ts checks
// that each one agrees with its predicate above in every state.
const stoppedSql = sql`${jobs.stop_event_id} like 'stop:%'`;
const pendingSql = sql`${jobs.t3_thread_id} like 'pending:%'`;
const boundSql = and(isNotNull(jobs.t3_thread_id), sql`${jobs.t3_thread_id} not like 'pending:%'`);
const unsentSql = sql`${jobs.stop_sent_to} is distinct from ${jobs.t3_thread_id}`;
const pendingStates = sql.join(PENDING_STOP_STATES.map((state) => sql`${state}`), sql`, `);

export const stopOwedSql = sql`(${stoppedSql} and (${pendingSql} or (${boundSql} and ${unsentSql})))`;
export const stopDeliverableSql = and(stoppedSql, boundSql, unsentSql);
export const stoppingSql = sql`coalesce(${jobs.stop}->>'state' in (${pendingStates}), false)`;
export const stopHeldSql = sql`coalesce(${jobs.stop}->>'state' = 'unconfirmed' and (${jobs.dismissed_at} is null or ${jobs.dismissed_at} < coalesce(${jobs.stop}->>'settledAt', ${jobs.stop}->>'requestedAt')::timestamptz), false)`;
const holdsSandboxSql = sql`(${jobs.sandbox_id} is not null or ${jobs.sandbox_snapshot} is not null or ${jobs.codex_slot} is not null)`;
export const canReclaimSql = sql`(${jobs.stage} = 'failed' and (${jobs.t3_thread_id} is null or not ${pendingSql}) and not coalesce(${stopOwedSql}, false) and not ${holdsSandboxSql} and not ${stoppingSql} and not ${stopHeldSql})`;

/** The same capacity rule for a raw `held` alias of jobs, as claimLaunch counts it. */
export const heldStoppingSql = sql`coalesce(held.stop->>'state' in (${pendingStates}), false)`;
