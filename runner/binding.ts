import { and, eq, isNotNull, sql } from "drizzle-orm";
import { issues, type IssueRow } from "../db/schema";

// How an issue relates to its T3 thread, and when a stop is still owed to it.
//
//   binding   t3_thread_id is null (none), a `pending:` launch marker, or a real thread id (bound)
//   stopped   stage failed by a stop (its stage event id starts with `stop:`)
//   owed      stopped, and either a launch is pending (its thread may still appear) or the bound
//             thread is not the one stop_sent_to names
//
// A stop is delivered only to a bound thread. Every runner binding goes through bindThread, which
// delivers an owed stop right after it binds; a binding made by ingest (the thread's own session
// start) is caught by the runner's issue subscription and its timer. A new attempt is refused
// while any launch is pending or a stop is owed, so no thread is left running unbound.

type Row = Pick<IssueRow, "stage" | "stage_event_id" | "t3_thread_id" | "stop_sent_to">;

export const PENDING = "pending:";

export function bindingOf(threadId: string | null) {
  if (!threadId) return "none";
  return threadId.startsWith(PENDING) ? "pending" : "bound";
}

export const isStopped = (i: Row) => i.stage === "failed" && Boolean(i.stage_event_id?.startsWith("stop:"));

export function stopOwed(i: Row) {
  if (!isStopped(i)) return false;
  const binding = bindingOf(i.t3_thread_id);
  return binding === "pending" || (binding === "bound" && i.stop_sent_to !== i.t3_thread_id);
}

export const stopDeliverable = (i: Row) => stopOwed(i) && bindingOf(i.t3_thread_id) === "bound";

export const canReclaim = (i: Row) => i.stage === "failed" && bindingOf(i.t3_thread_id) !== "pending" && !stopOwed(i);

// The same rules as SQL, for the queries that claim rows. scripts/launch-regressions.ts checks
// that each one agrees with its predicate above in every state.
const stoppedSql = and(eq(issues.stage, "failed"), sql`${issues.stage_event_id} like 'stop:%'`);
const pendingSql = sql`${issues.t3_thread_id} like 'pending:%'`;
const boundSql = and(isNotNull(issues.t3_thread_id), sql`${issues.t3_thread_id} not like 'pending:%'`);
const unsentSql = sql`${issues.stop_sent_to} is distinct from ${issues.t3_thread_id}`;

export const stopOwedSql = sql`(${stoppedSql} and (${pendingSql} or (${boundSql} and ${unsentSql})))`;
export const stopDeliverableSql = and(stoppedSql, boundSql, unsentSql);
export const canReclaimSql = sql`(${issues.stage} = 'failed' and (${issues.t3_thread_id} is null or not ${pendingSql}) and not coalesce(${stopOwedSql}, false))`;
