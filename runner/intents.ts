import { and, eq, isNull, like, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { intentReceipts, intents, type IntentKind } from "../db/schema";
import { ONLINE_WINDOW_MS } from "../lib/machine";
import { PAIRING_TTL_MINUTES, type PairingResult } from "../lib/t3-pairing";

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
  open_t3: "owner",
  approve_merge: "owner",
  request_changes: "owner",
  close_job: "owner",
  onboard_repo: "any",
  rebuild_repo_image: "any",
  repo_push: "any",
  retry_stop: "owner",
} as const satisfies Record<IntentKind, "any" | "owner" | "broadcast">;

/**
 * How often a failing intent is tried before it is closed with its error. A pairing link is asked
 * for by someone watching the panel, so it fails at once rather than retrying for a day; so does
 * an approval after a few tries, since the owner sees the error and can approve again. A GitHub
 * review that waits on its job gives up after REVIEW_WAIT_MS, so its tries outlast that day.
 */
export const INTENT_ATTEMPTS = {
  claim: 50,
  stop: 50,
  answer: 50,
  merged: 50,
  recheck_conflicts: 50,
  open_t3: 1,
  approve_merge: 3,
  request_changes: 60,
  close_job: 50,
  // Each try may start an onboarding sandbox; a repo that keeps failing shows why on its row.
  onboard_repo: 10,
  rebuild_repo_image: 10,
  repo_push: 20,
  // The owner sees the error on the inbox item and can retry again.
  retry_stop: 3,
} as const satisfies Record<IntentKind, number>;

/** An intent's result as the runner logs it: a pairing link only ever goes to the intent row. */
export function loggable(kind: IntentKind, result: object) {
  if (kind !== "open_t3" || !("pairUrl" in result)) return result;
  return { pairing: "minted", expiresAt: (result as Extract<PairingResult, { pairUrl: string }>).expiresAt };
}

/** Clears pairing links the panel never took once their token has expired. */
export async function expirePairings() {
  const cleared = await db
    .update(intents)
    .set({ result: JSON.stringify({ cleared: "expired" } satisfies PairingResult) })
    .where(
      and(
        eq(intents.kind, "open_t3"),
        like(intents.result, '%"pairUrl"%'),
        lt(intents.handled_at, sql`now() - make_interval(mins => ${PAIRING_TTL_MINUTES})`),
      ),
    )
    .returning({ id: intents.id });
  return cleared.length;
}

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

/**
 * Longer than the runner queue's step timeout, so a step the queue gave up on but that still runs
 * cannot be started again while it holds the lease. The timer redoes every intent's work, so a
 * crashed runner's intent waiting out its lease delays nothing that matters.
 */
export const LEASE_MINUTES = 10;
/** A broadcast stays open this long for machines that were offline when it arrived. */
const BROADCAST_MINUTES = 10;

/** Takes an open intent for this machine. A lease that ran out belongs to a runner that crashed or hung. */
export async function leaseIntent(id: string, machineId: string) {
  const leased = await db
    .update(intents)
    .set({ leased_by: machineId, lease_until: sql`now() + make_interval(mins => ${LEASE_MINUTES})` })
    .where(
      and(
        eq(intents.id, id),
        isNull(intents.handled_at),
        or(isNull(intents.leased_by), lt(intents.lease_until, sql`now()`)),
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

/** Closes a broadcast once no online machine is missing a receipt, or once it is too old to matter. */
export async function closeBroadcast(id: string) {
  const receipts = sql`(select count(*) from intent_receipts r where r.intent_id = ${id})`;
  const missing = sql`exists (
    select 1 from machines m
    where m.last_seen_at > now() - make_interval(secs => ${ONLINE_WINDOW_MS / 1000})
      and not exists (select 1 from intent_receipts r where r.intent_id = ${id} and r.machine_id = m.id)
  )`;
  await db
    .update(intents)
    .set({ handled_at: new Date(), result: sql`(${receipts})::text || ' receipts'` })
    .where(
      and(
        eq(intents.id, id),
        isNull(intents.handled_at),
        or(sql`${intents.created_at} < now() - make_interval(mins => ${BROADCAST_MINUTES})`, sql`not ${missing}`),
      ),
    );
}
