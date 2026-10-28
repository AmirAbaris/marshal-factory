import { db } from "../db/client";
import { auditLog, machines } from "../db/schema";
import type { Execution } from "../lib/execution";
import { harnessLabel, type Harness } from "../lib/harness";
import { reportedHarnesses } from "../lib/machine";
import { imageProblem } from "../lib/sandbox";
import type { EffectiveHarness, HarnessChoice } from "../lib/settings";
import { allSources, sourceFor } from "../lib/sources";
import type { Job, JobSource, SourceAdapter } from "../lib/sources/types";
import { readT3Runtime } from "../lib/t3-state";
import { desiredRepositoryGroup, readRegistry, type Registry } from "../lib/repositories";
import { desiredLabelGroups, ticketOverrides, type SourceOverrides, type TicketRecord } from "../lib/ticket-overrides";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { sandboxHarness, sandboxRuntime, usableSlots } from "./sandbox";

// Per ticket, the harness and where it runs are its override labels field by field over Settings.
// A label that cannot apply on this runner falls back, and the issue is told once per attempt.

/** What this runner can launch on right now. */
export type Capabilities = {
  /** This machine's T3 server is up. */
  local: boolean;
  /** This machine has a checkout of the job's repo; a local launch needs one. */
  checkout: boolean;
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
 * `settings` are the Settings with the job's repo defaults over them (lib/repositories.ts), so a
 * ticket label beats the repo default, which beats Settings. The ticket's harness replaces the
 * default one with its first current model, since the lead agent fans out to other models itself;
 * the default model applies only to the default harness. A local launch needs this machine's T3 up
 * and a checkout of the repo. A ticket asking for Modal where it cannot launch runs locally if it
 * can, and one asking for Local where it cannot runs on Modal if Modal can launch; otherwise it
 * waits queued. Without a Runs on label, a repo with no checkout here runs on Modal, or waits.
 */
export function planLaunch(
  overrides: SourceOverrides,
  settings: { harness: EffectiveHarness; execution: Execution },
  harnesses: readonly Harness[] | null,
  can: Capabilities,
): LaunchPlan {
  const asked = ticketOverrides(overrides, harnesses);
  const nameOf = (provider: string) => harnesses?.find((h) => h.id === provider)?.name ?? harnessLabel(provider);
  const notes = [...asked.problems];

  let harness: HarnessChoice = { provider: settings.harness.provider, model: settings.harness.model };
  if (asked.provider && asked.provider !== harness.provider) {
    const model = harnesses?.find((h) => h.id === asked.provider)?.models[0]?.slug;
    if (model) harness = { provider: asked.provider, model };
    else notes.push(`${nameOf(asked.provider)} reports no current model, so it runs on the Settings harness ${nameOf(harness.provider)}.`);
  }

  const noLocal = !can.local ? "this runner's T3 is not running" : !can.checkout ? "this runner has no checkout of the repo" : null;
  let execution = asked.execution ?? settings.execution;
  if (asked.execution === "modal" && can.modal) {
    if (noLocal) return { kind: "wait", reason: `Cloud sandboxes cannot launch on this runner (${can.modal}) and ${noLocal}` };
    execution = "local";
    notes.push(`Cloud sandboxes cannot launch on this runner (${can.modal}), so it runs locally.`);
  }
  if (asked.execution === "local" && noLocal) {
    if (can.modal) return { kind: "wait", reason: `${noLocal} and cloud sandboxes cannot launch here (${can.modal})` };
    execution = "modal";
    notes.push(`${noLocal[0]!.toUpperCase()}${noLocal.slice(1)}, so it runs in a cloud sandbox.`);
  }
  // A job only Settings or its repo send to local still needs the checkout; a down T3 fails its start as before.
  if (!asked.execution && execution === "local" && !can.checkout) {
    if (can.modal) return { kind: "wait", reason: `this runner has no checkout of the repo and cloud sandboxes cannot launch here (${can.modal})` };
    execution = "modal";
  }
  if (execution === "modal" && (asked.provider || asked.execution)) {
    const { fallback } = sandboxHarness(harness, can.driverOf(harness.provider), can.claude, can.codexModel);
    if (fallback) notes.push(`In a cloud sandbox, ${fallback}.`);
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
  registry: (): Promise<Registry> => readRegistry(db),
  localT3: () => readT3Runtime().up,
  note: (job: Job, key: string, body: string) => sourceFor(job.source).note(job, key, body),
  log: (event: string, detail: Record<string, unknown>) => sandboxRuntime.log(event, detail),
};

/** What this runner can launch on, before a job's repo is known; launchQueued sets checkout per job. */
export function capabilities(): Omit<Capabilities, "checkout"> {
  const limits = config.factory.sandbox;
  const modal =
    imageProblem(sandboxRuntime.image(), limits) ??
    (!sandboxRuntime.modalToken() ? "there is no cloud sandbox token" : usableSlots(limits).length === 0 ? "no Codex login slot is usable" : null);
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

/**
 * Creates the Harness, Runs on and Repository groups each source with override labels is missing,
 * with a child per enabled harness the machines report and per enabled repo. Before any machine
 * reports its harnesses, only the Repository group is synced.
 */
export async function syncOverrideLabels(sources = allSources()) {
  const [harnesses, registry] = await Promise.all([overrideRuntime.harnesses(), overrideRuntime.registry()]);
  const repositories = desiredRepositoryGroup(registry);
  const groups = [...(harnesses ? desiredLabelGroups(harnesses) : []), ...(repositories.children.length > 0 ? [repositories] : [])];
  if (groups.length === 0) return { skipped: "no machine reports its harnesses yet" };
  const synced: Record<string, Awaited<ReturnType<NonNullable<SourceAdapter<JobSource>["syncLabelGroups"]>>>> = {};
  for (const source of sources) if (source.syncLabelGroups) synced[source.source] = await source.syncLabelGroups(groups);
  return { synced };
}
