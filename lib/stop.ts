import { z } from "zod";

// A stop ends in a verified state, not just a delivered message. Pure, so the runner, the panel,
// the inbox and the regressions share the rules; runner/stops.ts drives it.
//
//   requested    recorded with the job's failure; nothing has reached the thread yet
//   delivered    the stop message reached the bound thread, or the job's sandbox is being ended
//   escalated    the thread or one of its subagent threads still ran after the grace, so the runner
//                asked T3 to interrupt them
//   confirmed    T3 showed the thread and every subagent thread without an active run for the
//                settle time, or the job's sandbox is verifiably gone, or no thread was ever started
//   unconfirmed  still running, or unreadable, after the final timeout; the owner gets an inbox item
//
// While a stop is requested, delivered or escalated the job keeps its launch capacity and its
// source hears nothing; confirmed and unconfirmed free both.

export const STOP_STATES = ["requested", "delivered", "escalated", "confirmed", "unconfirmed"] as const;
export type StopState = (typeof STOP_STATES)[number];
export const PENDING_STOP_STATES = ["requested", "delivered", "escalated"] as const satisfies readonly StopState[];

/** How the stop last reached the work: the polite message, T3's interrupt, or ending the sandbox. */
export const STOP_HOWS = ["message", "interrupt", "terminate"] as const;
export type StopHow = (typeof STOP_HOWS)[number];

const at = z.string();

export const stopSchema = z.object({
  state: z.enum(STOP_STATES),
  requestedAt: at,
  by: z.string(),
  reason: z.string(),
  /** Whether the source goes back to not started once the stop settles, so the label retries it. */
  reopen: z.boolean(),
  /** The thread the stop was delivered to; a new binding delivers again. */
  thread: z.string().nullable().default(null),
  how: z.enum(STOP_HOWS).nullable().default(null),
  deliveredAt: at.nullable().default(null),
  escalatedAt: at.nullable().default(null),
  /** Since when T3 has shown the thread and its subagents without an active run; cleared when one runs. */
  quietSince: at.nullable().default(null),
  /** The last look, so ticks closer than the check interval don't ask T3 again. */
  checkedAt: at.nullable().default(null),
  /** What the runner last saw or did, in a sentence. */
  step: z.string().nullable().default(null),
  settledAt: at.nullable().default(null),
  /** Why the stop counts as confirmed, or why it could not be. */
  evidence: z.string().nullable().default(null),
  /** How often the owner asked to retry an unconfirmed stop. */
  retries: z.number().int().nonnegative().default(0),
});
export type StopRecord = z.infer<typeof stopSchema>;

export const parseStop = (value: unknown): StopRecord | null => stopSchema.safeParse(value).data ?? null;

export const isStopPending = (stop: StopRecord | null) => stop !== null && (PENDING_STOP_STATES as readonly StopState[]).includes(stop.state);

/** An unconfirmed stop the owner has not dismissed since it was marked: it waits on them, and holds off a new attempt. */
export function stopNeedsOwner(value: unknown, dismissedAt: Date | null | undefined) {
  const stop = parseStop(value);
  if (stop?.state !== "unconfirmed") return false;
  return !dismissedAt || dismissedAt.getTime() < new Date(stop.settledAt ?? stop.requestedAt).getTime();
}

export function requestedStop({ at, by, reason, reopen }: { at: Date; by: string; reason: string; reopen: boolean }): StopRecord {
  return stopSchema.parse({ state: "requested", requestedAt: at.toISOString(), by, reason, reopen });
}

/** Stop timings, in milliseconds; the runner reads them from config.factory.stop. */
export type StopTimings = { checkMs: number; settleMs: number; interruptAfterMs: number; giveUpAfterMs: number };

export type StopView =
  | { kind: "stopping"; step: "sending the stop" | "asked the agent" | "interrupting" | "ending the sandbox" | "waiting to confirm" }
  | { kind: "confirmed"; evidence: string }
  | { kind: "unconfirmed"; reason: string };

/** What the panel says about a job's stop; null when it has none. `sandboxed` jobs are stopped by ending their sandbox. */
export function stopView(value: unknown, sandboxed: boolean): StopView | null {
  const stop = parseStop(value);
  if (!stop) return null;
  switch (stop.state) {
    case "requested":
      return { kind: "stopping", step: sandboxed ? "ending the sandbox" : "sending the stop" };
    case "delivered":
      if (sandboxed) return { kind: "stopping", step: "ending the sandbox" };
      return { kind: "stopping", step: stop.quietSince ? "waiting to confirm" : "asked the agent" };
    case "escalated":
      return { kind: "stopping", step: stop.quietSince ? "waiting to confirm" : "interrupting" };
    case "confirmed":
      return { kind: "confirmed", evidence: stop.evidence ?? "The work stopped." };
    case "unconfirmed":
      return { kind: "unconfirmed", reason: stop.evidence ?? "The runner could not confirm that the work stopped." };
    default: {
      const never: never = stop.state;
      throw new Error(`unknown stop state ${String(never)}`);
    }
  }
}

export function stopLine(view: StopView) {
  switch (view.kind) {
    case "stopping":
      return `Stopping… (${view.step})`;
    case "confirmed":
      return "Stopped · confirmed";
    case "unconfirmed":
      return "Stop not confirmed — check the thread in T3";
    default: {
      const never: never = view;
      throw new Error(`unknown stop view ${JSON.stringify(never)}`);
    }
  }
}
