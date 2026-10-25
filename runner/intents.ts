import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { intentReceipts, intents, type IntentKind } from "../db/schema";
import { ONLINE_WINDOW_MS } from "../lib/machine";

// Which machine acts on an intent. A job belongs to the machine in jobs.machine_id: only that
// machine can reach its T3 thread, its worktree and its transcripts.
//
//   any        one machine, whichever leases it first; a claim ends in claimLaunch's compare-and-set
//   owner      the job's machine; a job no machine holds yet goes to any machine
//   broadcast  every machine once, each recording its own intent_receipts row
export const INTENT_ROUTES = {
  claim: "any",
  stop: "owner",
  answer: "owner",
  merged: "owner",
  recheck_conflicts: "broadcast",
} as const satisfies Record<IntentKind, "any" | "owner" | "broadcast">;

export type Delivery = "lease" | "receipt" | "skip";

export function deliveryFor(kind: IntentKind, owner: string | null, me: string): Delivery {
  const route = INTENT_ROUTES[kind];
  switch (route) {
    case "any":
      return "lease";
    case "owner":
      return owner === null || owner === me ? "lease" : "skip";
    case "broadcast":
      return "receipt";
    default: {
      const unhandled: never = route;
      throw new Error(`no delivery for route ${String(unhandled)}`);
    }
  }
}

export const LEASE_MINUTES = 5;
/** A broadcast stays open this long for machines that were offline when it arrived. */
const BROADCAST_MINUTES = 10;

/**
 * Takes an open intent for this machine. A lease that ran out belongs to a machine that crashed
 * or hung, so another one takes it; this machine retakes its own lease after a restart.
 */
export async function leaseIntent(id: string, machineId: string) {
  const leased = await db
    .update(intents)
    .set({ leased_by: machineId, lease_until: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
    .where(
      and(
        eq(intents.id, id),
        isNull(intents.handled_at),
        or(isNull(intents.leased_by), eq(intents.leased_by, machineId), lt(intents.lease_until, sql`now()`)),
      ),
    )
    .returning({ id: intents.id });
  return leased.length > 0;
}

/** Records that this machine took a broadcast; false when it already had. */
export async function receiptIntent(id: string, machineId: string) {
  const inserted = await db
    .insert(intentReceipts)
    .values({ intent_id: id, machine_id: machineId, handled_at: new Date() })
    .onConflictDoNothing()
    .returning({ id: intentReceipts.intent_id });
  return inserted.length > 0;
}

export async function recordReceipt(id: string, machineId: string, result: unknown) {
  await db
    .update(intentReceipts)
    .set({ result: JSON.stringify(result).slice(0, 2000) })
    .where(and(eq(intentReceipts.intent_id, id), eq(intentReceipts.machine_id, machineId)));
}

/** Closes a broadcast once every online machine has a receipt, or once it is too old to matter. */
export async function closeBroadcast(id: string) {
  const receipts = sql`(select count(*) from intent_receipts r where r.intent_id = ${id})`;
  const online = sql`(select count(*) from machines m where m.last_seen_at > now() - make_interval(secs => ${ONLINE_WINDOW_MS / 1000}))`;
  await db
    .update(intents)
    .set({ handled_at: new Date(), result: sql`(${receipts})::text || ' receipts'` })
    .where(
      and(
        eq(intents.id, id),
        isNull(intents.handled_at),
        or(sql`${intents.created_at} < now() - make_interval(mins => ${BROADCAST_MINUTES})`, sql`${receipts} >= ${online}`),
      ),
    );
}
