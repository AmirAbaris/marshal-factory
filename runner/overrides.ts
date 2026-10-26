import { db } from "../db/client";
import { auditLog, machines } from "../db/schema";
import type { Execution } from "../lib/execution";
import { harnessLabel, type Harness } from "../lib/harness";
import { reportedHarnesses } from "../lib/machine";
import { imageProblem } from "../lib/sandbox";
import type { EffectiveHarness, HarnessChoice } from "../lib/settings";
import { sourceFor } from "../lib/sources";
import type { Job } from "../lib/sources/types";
import { readT3Runtime } from "../lib/t3-state";
import { desiredLabelGroups, ticketOverrides, type TicketLabel, type TicketRecord } from "../lib/ticket-overrides";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { sandboxHarness, sandboxRuntime, usableSlots } from "./sandbox";

// Per ticket, the harness and where it runs are its override labels field by field over Settings.
// A label that cannot apply on this runner falls back, and the issue is told once per attempt.

/** What this runner can launch on right now. */
export type Capabilities = {
  /** This machine's T3 server is up. */
  local: boolean;
  /** Why Modal cannot launch here; null when it can, even if every slot is busy right now. */
  modal: string | null;
  claude: boolean;
  driverOf: (provider: string) => string;
  codexModel: string;
};

export type LaunchPlan =
  | { kind: "launch"; execution: Execution; harness: HarnessChoice; ticket: TicketRecord | null }
  | { kind: "wait"; reason: string };

/**
 * The ticket's harness replaces the Settings one with its first current model, since the lead
 * agent fans out to other models itself; the Settings model applies only to the Settings harness.
 * A ticket asking for Modal where it cannot launch runs locally if this machine's T3 is up, and one
 * asking for Local without a T3 here runs on Modal if it can launch; otherwise it waits queued.
 */
export function planLaunch(
  labels: readonly TicketLabel[],
  settings: { harness: EffectiveHarness; execution: Execution },
  harnesses: readonly Harness[] | null,
  can: Capabilities,
): LaunchPlan {
  const asked = ticketOverrides(labels, harnesses);
  const nameOf = (provider: string) => harnesses?.find((h) => h.id === provider)?.name ?? harnessLabel(provider);
  const notes = [...asked.problems];

  let harness: HarnessChoice = { provider: settings.harness.provider, model: settings.harness.model };
  if (asked.provider && asked.provider !== harness.provider) {
    const model = harnesses?.find((h) => h.id === asked.provider)?.models[0]?.slug;
    if (model) harness = { provider: asked.provider, model };
    else notes.push(`${nameOf(asked.provider)} reports no current model, so it runs on the Settings harness ${nameOf(harness.provider)}.`);
  }

  let execution = asked.execution ?? settings.execution;
  if (asked.execution === "modal" && can.modal) {
    if (!can.local) return { kind: "wait", reason: `Modal cannot launch on this runner (${can.modal}) and its T3 is not running` };
    execution = "local";
    notes.push(`Modal cannot launch on this runner (${can.modal}), so it runs locally.`);
  }
  if (asked.execution === "local" && !can.local) {
    if (can.modal) return { kind: "wait", reason: `this runner's T3 is not running and Modal cannot launch here (${can.modal})` };
    execution = "modal";
    notes.push("This runner's T3 is not running, so it runs in a Modal sandbox.");
  }
  if (execution === "modal" && (asked.provider || asked.execution)) {
    const { fallback } = sandboxHarness(harness, can.driverOf(harness.provider), can.claude, can.codexModel);
    if (fallback) notes.push(`In a Modal sandbox, ${fallback}.`);
  }

  const applied = {
    ...(asked.provider === harness.provider && { provider: asked.provider }),
    ...(asked.execution === execution && { execution }),
  };
  const ticket = Object.keys(applied).length > 0 || notes.length > 0 ? { ...applied, notes } : null;
  return { kind: "launch", execution, harness, ticket };
}

export function splitByExecution<T extends { execution: Execution }>(planned: readonly T[]) {
  const split: Record<Execution, T[]> = { local: [], modal: [] };
  for (const entry of planned) {
    switch (entry.execution) {
      case "local":
      case "modal":
        split[entry.execution].push(entry);
        break;
      default: {
        const never: never = entry.execution;
        throw new Error(`unknown execution ${String(never)}`);
      }
    }
  }
  return split;
}

/** What planning reads from this machine and the database; regressions replace any of it. */
export const overrideRuntime = {
  harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
  localT3: () => readT3Runtime().up,
  note: (job: Job, key: string, body: string) => sourceFor(job.source).note(job, key, body),
  log: (event: string, detail: Record<string, unknown>) => sandboxRuntime.log(event, detail),
};

export function capabilities(): Capabilities {
  const limits = config.factory.sandbox;
  const modal =
    imageProblem(sandboxRuntime.image(), limits) ??
    (!sandboxRuntime.modalToken() ? "there is no Modal token" : usableSlots(limits).length === 0 ? "no Codex login slot is usable" : null);
  return {
    local: overrideRuntime.localT3(),
    modal,
    claude: Boolean(sandboxRuntime.claudeToken()),
    driverOf: sandboxRuntime.driverOf,
    codexModel: limits.codexModel,
  };
}

export const fallbackNoteKey = (attempt: number) => `ticket-overrides:${attempt}`;

export const fallbackComment = (notes: readonly string[]) =>
  ["marshal-factory could not apply this issue's override labels as they are:", "", ...notes.map((n) => `- ${n}`)].join("\n");

/**
 * Tells the issue and the audit log about this attempt's fallbacks, once: the comment and the
 * audit row are keyed on the attempt, so a relaunch or another tick adds nothing. A failure is
 * logged; it never holds back the launch.
 */
export async function announceFallbacks(job: Job, ticket: TicketRecord | null) {
  if (!ticket || ticket.notes.length === 0) return;
  const body = fallbackComment(ticket.notes);
  try {
    await db
      .insert(auditLog)
      .values({
        id: `override:${job.id}:${job.attempt}`,
        at: new Date(),
        actor: `runner ${(await thisMachine()).name}`,
        action: "override_fallback",
        job_id: job.id,
        target: job.url,
        head_sha: "",
        result: "ok",
        detail: ticket.notes.join(" "),
      })
      .onConflictDoNothing();
    await overrideRuntime.note(job, fallbackNoteKey(job.attempt), body);
  } catch (error) {
    overrideRuntime.log("override:announce-failed", { key: job.key, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Creates the Harness and Runs on groups the team is missing, with a child per enabled harness the machines report. */
export async function syncLinearLabels(source = sourceFor("linear")) {
  const harnesses = await overrideRuntime.harnesses();
  if (!harnesses) return { skipped: "no machine reports its harnesses yet" };
  return source.syncLabelGroups!(desiredLabelGroups(harnesses));
}
