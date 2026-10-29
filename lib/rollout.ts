import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CONFIG_PATH } from "./config";

// What scripts/rollout.ts reads besides git: the commit it last rolled out, and the runner log
// after a restart.

/** The last commit a rollout finished with, next to the config. */
export const ROLLOUT_PATH = join(dirname(CONFIG_PATH), "rollout.json");

export const rolloutSchema = z.object({ commit: z.string().min(1), at: z.string() });
export type Rollout = z.infer<typeof rolloutSchema>;

/** The recorded rollout, or null when none finished yet or the record is unreadable. */
export function readRollout(path = ROLLOUT_PATH): Rollout | null {
  if (!existsSync(path)) return null;
  try {
    return rolloutSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/**
 * The files among `changed` that a bundle with these inputs is built from. A dependency counts
 * through bun.lock and package.json, since a bundle input under node_modules has no history.
 */
export function touchedInputs(changed: readonly string[], inputs: readonly string[]) {
  const watched = new Set(inputs.filter((p) => !p.includes("node_modules/")));
  if (inputs.some((p) => p.includes("node_modules/"))) for (const p of ["bun.lock", "package.json"]) watched.add(p);
  return changed.filter((p) => watched.has(p));
}

export type StartupVerdict = { state: "waiting" } | { state: "clean"; at: string } | { state: "failed"; why: string };

const logLineSchema = z.object({ at: z.string(), event: z.string(), result: z.unknown().optional() }).loose();

/** The steps of a tick or reconcile result that returned an error instead of their result. */
const failedSteps = (result: unknown) =>
  result && typeof result === "object" ? Object.entries(result).filter(([, v]) => v && typeof v === "object" && "error" in v).map(([k]) => k) : [];

/**
 * How the runner came up, from the log lines written since it was restarted: clean at its first
 * tick after `start` when neither that tick nor the startup reconcile had a failed step and no
 * step errored in between. A second `start` means it crashed and launchd started it again.
 */
export function startupVerdict(lines: readonly string[]): StartupVerdict {
  let started = false;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = logLineSchema.safeParse(parsed);
    if (!entry.success) continue;
    const { event, at, result } = entry.data;
    if (event === "start") {
      if (started) return { state: "failed", why: `the runner started again at ${at} before its first tick` };
      started = true;
      continue;
    }
    if (!started) continue;
    if (event.endsWith(":error") || event.endsWith(":late-error") || event === "unhandledRejection") return { state: "failed", why: line };
    if (event === "reconcile" || event === "tick") {
      const failed = failedSteps(result);
      if (failed.length > 0) return { state: "failed", why: `${event} at ${at} failed in ${failed.join(", ")}: ${line}` };
      if (event === "tick") return { state: "clean", at };
    }
  }
  return { state: "waiting" };
}
