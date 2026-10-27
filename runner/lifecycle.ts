import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client";
import { auditLog, codexSlotLeases, jobs, repoSettings, type JobRow } from "../db/schema";
import type { RepoName } from "../lib/github/app";
import { HostGoneError, hosts, isHibernated, type HostedJob, type JobHost } from "../lib/host";
import { deleteSnapshot, isModalGone, modal, modalHost, snapshotSandbox, terminateSandbox, tunnelUrl } from "../lib/modal-host";
import { modalSecretName, parseDetail } from "../lib/onboarding";
import { CODEX_AUTH, T3_PORT } from "../lib/sandbox";
import { readSettings, resolveExecution } from "../lib/settings";
import type { JobId } from "../lib/sources/shapes";
import { parseStop } from "../lib/stop";
import { HIBERNATED_MESSAGE, type PairingResult } from "../lib/t3-pairing";
import { bindingOf, PENDING, stopOwed, stopping } from "./binding";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { flushSandboxOutbox } from "./outbox";
import { isolated } from "./reconcile";
import { CodexLoginError, createJobSandbox, installCodexLogin, markSlotUnusable, pairT3, sandboxRuntime, startT3, stopT3, usableSlots, writeGithubToken } from "./sandbox";
import { threads } from "./threads";
import { verifyingKeys } from "./verify";

// What happens to a job's Modal sandbox after its launch. A sandbox bills by the second while it
// runs, idle or not, so a job that waits on the outside world gives its sandbox up:
//
//   running     sandbox_id set; the thread works, or waits in pr or waiting until it settles
//   hibernated  pr or waiting, thread settled: the login is written back, the filesystem (worktree,
//               T3's SQLite, Codex sessions) is snapshotted to sandbox_snapshot, the sandbox ends
//               and the login slot is freed
//   woken       an operation that must reach the thread (conflict send-back, answer delivery)
//               starts a sandbox from the snapshot with a freshly leased slot, a fresh GitHub token
//               and a new `t3 serve`; the snapshot is deleted once it serves
//   torn down   merged or failed: the login is written back, the sandbox ends, the snapshot is
//               deleted, and sandbox_id, sandbox_snapshot and codex_slot are cleared
//
// A sandbox that hits its timeout (config sandbox.timeoutMs) is gone: its threads count as gone and
// the job follows the existing gone rules (watchdog fail, conflict fail, resume relaunch). The
// runner runs one step at a time, so a row with both sandbox_id and sandbox_snapshot set is a
// hibernate or wake that a crash cut short; it settles back to hibernated.

const HIBERNATE_STAGES = ["pr", "waiting"] as const;
const TERMINAL_STAGES = ["merged", "failed"] as const;
export const TOKEN_REFRESH_MS = 40 * 60_000;
export const REAP_EVERY_MS = 5 * 60_000;

const log = (event: string, detail: Record<string, unknown>) => sandboxRuntime.log(event, detail);
const message = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0] : String(error));
const mine = async () => eq(jobs.machine_id, (await thisMachine()).id);
const notPending = or(isNull(jobs.t3_thread_id), sql`${jobs.t3_thread_id} not like ${`${PENDING}%`}`);
const holdsSandbox = or(isNotNull(jobs.sandbox_id), isNotNull(jobs.sandbox_snapshot), isNotNull(jobs.codex_slot));

/** When each running sandbox last got a GitHub token; unknown after a restart, which refreshes at once. */
const tokenWrites = new Map<string, number>();
export const noteTokenWritten = (sandboxId: string, at = Date.now()) => void tokenWrites.set(sandboxId, at);
/** When this runner last woke each job, so a job it just woke is not put straight back to sleep. */
const wokenAt = new Map<string, number>();

/** Runs a step per job, so one failure does not hold back the rest. */
async function each<T extends { key: string }>(rows: readonly T[], step: (row: T) => Promise<string | undefined>) {
  const done: string[] = [];
  const errors: { key: string; error: string }[] = [];
  for (const row of rows) {
    try {
      const outcome = await step(row);
      if (outcome) done.push(`${row.key}:${outcome}`);
    } catch (error) {
      errors.push({ key: row.key, error: message(error) });
    }
  }
  return errors.length > 0 ? { done, errors } : done;
}

const uniqueViolation = (error: unknown): boolean =>
  (error as { code?: string })?.code === "23505" || (error instanceof Error && error.cause !== undefined && uniqueViolation(error.cause));

/** Slots a job or an onboarding run holds; see codex_slot_leases in db/schema.ts. */
export async function leasedSlots() {
  return new Set((await db.select({ slot: codexSlotLeases.slot }).from(codexSlotLeases)).map((r) => r.slot));
}

/**
 * Leases a free login slot to the job row `where` matches. Setting codex_slot takes the slot's row
 * in codex_slot_leases, so the lease is atomic against jobs and onboarding runs alike: a slot taken
 * in between fails the write and the next free one is tried. Undefined when every slot is held or
 * the row no longer matches.
 */
export async function leaseSlot(where: SQL | undefined, slots: readonly string[]) {
  const held = await leasedSlots();
  for (const slot of slots.filter((s) => !held.has(s))) {
    try {
      const leased = await db
        .update(jobs)
        .set({ codex_slot: slot })
        .where(and(where, isNull(jobs.codex_slot)))
        .returning({ key: jobs.key });
      return leased.length > 0 ? slot : undefined;
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
    }
  }
  return undefined;
}

const isJsonObject = (text: string) => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
};

/**
 * Codex refreshes its ChatGPT tokens in the sandbox, and the old refresh token stops working, so
 * the slot gets the sandbox's auth.json back whenever it differs. A sandbox already gone has
 * nothing to give; that is logged and the caller goes on. The contents are never logged.
 */
export async function writeBackLogin(key: string, sandboxId: string, slot: string | null) {
  if (!slot) return "no slot";
  let text: string | null;
  try {
    text = await modalHost(sandboxId).readFile(CODEX_AUTH);
  } catch (error) {
    if (!(error instanceof HostGoneError)) throw error;
    log("sandbox:login-writeback-skipped", { key, slot, reason: "the sandbox is gone" });
    return "gone";
  }
  if (text === null || !isJsonObject(text)) return "missing";
  let current: string | null = null;
  try {
    current = sandboxRuntime.slotAuth(slot);
  } catch {
    // A slot whose file went missing gets the sandbox's login.
  }
  if (text === current) return "unchanged";
  sandboxRuntime.writeSlotAuth(slot, text);
  log("sandbox:login-written-back", { key, slot });
  return "written";
}

/** Every end of a job's sandbox: undelivered reports and the login leave it first. */
export async function retireSandbox(key: string, sandboxId: string, slot: string | null) {
  await flushSandboxOutbox(key, modalHost(sandboxId));
  await writeBackLogin(key, sandboxId, slot);
  await terminateSandbox(sandboxId);
  tokenWrites.delete(sandboxId);
}

/** A slot whose login Codex refused: skipped from now on, and the job's audit log says so. */
export async function loginFailed(key: string, slot: string) {
  markSlotUnusable(slot, "codex login status reported no login in a sandbox");
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.key, key));
  if (job) {
    await db.insert(auditLog).values({
      id: randomUUID(),
      at: new Date(),
      actor: `runner ${(await thisMachine()).name}`,
      action: "sandbox_login_failed",
      job_id: job.id,
      target: slot,
      head_sha: "",
      result: "error",
      detail: `Codex is not logged in with ${slot}; the slot is skipped until it logs in again.`,
    });
  }
  log("sandbox:login-failed", { key, slot });
}

type SandboxRow = Pick<JobRow, "key" | "sandbox_id" | "sandbox_snapshot" | "codex_slot" | "t3_thread_id" | "stage" | "stop_event_id" | "stop_sent_to"> &
  Partial<Pick<JobRow, "stop">>;

/** Throws unless Modal no longer runs anything in the sandbox: a command there must find it gone. */
async function verifyGone(sandboxId: string) {
  try {
    await modalHost(sandboxId).exists("/");
  } catch (error) {
    if (error instanceof HostGoneError) return;
    throw error;
  }
  throw new Error(`sandbox ${sandboxId} still answers after it was terminated`);
}

/**
 * Ends everything the job's sandbox holds: the running sandbox, its snapshot and its slot. A stop
 * still owed to the thread is settled too, since the thread ended with the sandbox. A stop on its
 * way records the termination once Modal no longer answers for the sandbox; runner/stops.ts then
 * confirms it. Idempotent.
 */
export async function teardownSandbox(row: SandboxRow) {
  if (!row.sandbox_id && !row.sandbox_snapshot && !row.codex_slot) return;
  if (row.sandbox_id) await retireSandbox(row.key, row.sandbox_id, row.codex_slot);
  const stop = stopping(row) ? parseStop(row.stop) : null;
  if (row.sandbox_id && stop) await verifyGone(row.sandbox_id);
  if (row.sandbox_snapshot) await deleteSnapshot(row.sandbox_snapshot);
  const threadEnded = stopOwed(row) && bindingOf(row.t3_thread_id) === "bound";
  const ended = row.sandbox_id ? `Ended sandbox ${row.sandbox_id}; Modal no longer runs it.` : "The sandbox was already hibernated; its snapshot is deleted.";
  await db
    .update(jobs)
    .set({
      sandbox_id: null,
      sandbox_snapshot: null,
      codex_slot: null,
      ...(threadEnded && { stop_sent_to: row.t3_thread_id }),
      ...(stop && { stop: { ...stop, how: "terminate" as const, step: ended } }),
    })
    .where(
      and(
        eq(jobs.key, row.key),
        sql`${jobs.sandbox_id} is not distinct from ${row.sandbox_id}`,
        sql`${jobs.sandbox_snapshot} is not distinct from ${row.sandbox_snapshot}`,
      ),
    );
  log("sandbox:torn-down", { key: row.key, sandbox: row.sandbox_id, snapshot: Boolean(row.sandbox_snapshot) });
}

/** Merged and failed jobs give back their sandbox, snapshot and slot. A pending launch is left to launch recovery. */
export async function teardownFinished() {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(await mine(), inArray(jobs.stage, [...TERMINAL_STAGES]), holdsSandbox, notPending));
  return each(rows, async (row) => (await teardownSandbox(row), "torn down"));
}

/** A hibernate or wake that a crash cut short: the snapshot is kept and the sandbox ends. */
export async function settleInterrupted() {
  const rows = await db
    .select()
    .from(jobs)
    .where(and(await mine(), isNotNull(jobs.sandbox_id), isNotNull(jobs.sandbox_snapshot), notPending));
  return each(rows, async (row) => {
    await retireSandbox(row.key, row.sandbox_id!, row.codex_slot);
    await db
      .update(jobs)
      .set({ sandbox_id: null, codex_slot: null })
      .where(and(eq(jobs.key, row.key), eq(jobs.sandbox_id, row.sandbox_id!)));
    return "settled";
  });
}

/**
 * Snapshots and ends the sandbox of each job that waits in pr or waiting with a settled thread,
 * after hibernateAfterMinutes. A stop still owed is delivered first. A thread already gone has
 * nothing worth keeping: its sandbox ends and its slot is freed, and sandbox_id stays so the job
 * keeps reading as gone.
 */
export async function hibernateIdle(now = Date.now()) {
  const graceMs = config.factory.sandbox.hibernateAfterMinutes * 60_000;
  const rows = await db
    .select()
    .from(jobs)
    .where(and(await mine(), inArray(jobs.stage, [...HIBERNATE_STAGES]), isNotNull(jobs.sandbox_id), isNull(jobs.sandbox_snapshot), isNotNull(jobs.t3_thread_id), notPending));
  const verifying = verifyingKeys();
  return each(rows, async (row) => {
    if (stopOwed(row) || verifying.has(row.key)) return undefined;
    const quietSince = Math.max(row.stage_at?.getTime() ?? row.updated_at.getTime(), wokenAt.get(row.key) ?? 0);
    if (now - quietSince < graceMs) return undefined;
    const sandboxId = row.sandbox_id!;
    const host = modalHost(sandboxId);
    const state = await threads.state(row.t3_thread_id, host);
    if (state === "running") return undefined;
    if (state === "gone") {
      await retireSandbox(row.key, sandboxId, row.codex_slot);
      await db.update(jobs).set({ codex_slot: null }).where(and(eq(jobs.key, row.key), eq(jobs.sandbox_id, sandboxId)));
      return row.codex_slot ? "gone, slot freed" : undefined;
    }
    // Whatever stays undelivered is in the snapshot, and the wake flushes it. A report delivered
    // now may have moved the job on, and then it is not idle.
    if ((await flushSandboxOutbox(row.key, host))?.delivered) {
      const [current] = await db.select({ stage: jobs.stage }).from(jobs).where(eq(jobs.key, row.key));
      if (current?.stage !== row.stage) return undefined;
    }
    await writeBackLogin(row.key, sandboxId, row.codex_slot);
    await stopT3(host);
    let imageId: string;
    try {
      imageId = await snapshotSandbox(sandboxId, config.factory.sandbox.snapshotTtlDays * 86_400_000);
    } catch (error) {
      if (!(error instanceof HostGoneError)) await startT3(host).catch(() => {});
      throw error;
    }
    const [kept] = await db
      .update(jobs)
      .set({ sandbox_snapshot: imageId })
      .where(and(eq(jobs.key, row.key), eq(jobs.sandbox_id, sandboxId), isNull(jobs.sandbox_snapshot)))
      .returning({ key: jobs.key });
    if (!kept) {
      await deleteSnapshot(imageId);
      return undefined;
    }
    await terminateSandbox(sandboxId);
    tokenWrites.delete(sandboxId);
    await db.update(jobs).set({ sandbox_id: null, codex_slot: null }).where(and(eq(jobs.key, row.key), eq(jobs.sandbox_id, sandboxId)));
    log("sandbox:hibernated", { key: row.key, sandbox: sandboxId, stage: row.stage });
    return "hibernated";
  });
}

/**
 * Starts a hibernated job's sandbox again from its snapshot, with a freshly leased slot, a fresh
 * GitHub token and a serving T3, and returns its host. A failure ends the new sandbox and frees the
 * slot, keeping the snapshot for the next try; a slot whose login fails is marked unusable. A
 * snapshot Modal no longer has throws HostGoneError, so the thread counts as gone.
 */
export async function wakeJob(job: HostedJob): Promise<JobHost> {
  let [row] = await db.select().from(jobs).where(eq(jobs.key, job.key));
  if (row?.sandbox_id && row.sandbox_snapshot) {
    await settleInterrupted();
    [row] = await db.select().from(jobs).where(eq(jobs.key, job.key));
  }
  if (!row) throw new Error(`No claimed job ${job.key}`);
  if (!isHibernated(row)) return hosts.forJob(row);
  const snapshot = row.sandbox_snapshot!;
  const limits = config.factory.sandbox;
  const asleep = and(eq(jobs.key, row.key), eq(jobs.sandbox_snapshot, snapshot), isNull(jobs.sandbox_id));
  const slot = await leaseSlot(asleep, usableSlots(limits));
  if (!slot) throw new Error(`no free Codex login slot to wake ${row.key}`);
  let sandboxId: string | undefined;
  try {
    const claudeToken = sandboxRuntime.claudeToken();
    const [repoRow] = await db.select().from(repoSettings).where(eq(repoSettings.repo, row.repo));
    const created = await createJobSandbox({
      namedSecrets: repoRow && (parseDetail(repoRow.onboarding_detail).secretsSet ?? []).length > 0 ? [modalSecretName(row.repo)] : [],
      key: row.key,
      attempt: row.attempt,
      label: config.factory.label,
      machineId: (await thisMachine()).id,
      imageId: snapshot,
      limits,
      claudeToken,
    }).catch((error: unknown) => {
      throw isModalGone(error) ? new HostGoneError(`${row.key}'s snapshot ${snapshot} is gone: ${message(error)}`) : error;
    });
    sandboxId = created.sandboxId;
    const [recorded] = await db.update(jobs).set({ sandbox_id: sandboxId }).where(asleep).returning({ key: jobs.key });
    if (!recorded) throw new Error(`${row.key} changed while it was being woken`);
    await installCodexLogin(created.host, slot, sandboxRuntime.slotAuth(slot));
    await writeGithubToken(created.host, await sandboxRuntime.githubToken(row.repo as RepoName));
    noteTokenWritten(sandboxId);
    await startT3(created.host);
    await flushSandboxOutbox(row.key, created.host);
    await db.update(jobs).set({ sandbox_snapshot: null }).where(and(eq(jobs.key, row.key), eq(jobs.sandbox_id, sandboxId)));
    wokenAt.set(row.key, Date.now());
    log("sandbox:woken", { key: row.key, sandbox: sandboxId, slot });
    await deleteSnapshot(snapshot).catch((error: unknown) => log("sandbox:snapshot-delete-failed", { key: row.key, snapshot, error: message(error) }));
    return created.host;
  } catch (error) {
    if (error instanceof CodexLoginError) await loginFailed(row.key, slot);
    if (sandboxId) await retireSandbox(row.key, sandboxId, slot);
    await db
      .update(jobs)
      .set({ sandbox_id: null, codex_slot: null })
      .where(and(eq(jobs.key, row.key), eq(jobs.sandbox_snapshot, snapshot)));
    throw error;
  }
}

hosts.wake = wakeJob;

/** Installation tokens last an hour: each running sandbox gets a fresh one every 40 minutes. */
export async function refreshTokens(now = Date.now()) {
  const rows = await db.select().from(jobs).where(and(await mine(), isNotNull(jobs.sandbox_id)));
  const live = new Set(rows.map((r) => r.sandbox_id!));
  for (const sandboxId of tokenWrites.keys()) if (!live.has(sandboxId)) tokenWrites.delete(sandboxId);
  return each(rows, async (row) => {
    const sandboxId = row.sandbox_id!;
    const last = tokenWrites.get(sandboxId);
    if (last !== undefined && now - last < TOKEN_REFRESH_MS) return undefined;
    try {
      await writeGithubToken(modalHost(sandboxId), await sandboxRuntime.githubToken(row.repo as RepoName));
    } catch (error) {
      if (error instanceof HostGoneError) return undefined;
      throw error;
    }
    tokenWrites.set(sandboxId, now);
    return "token";
  });
}

const SANDBOX_GONE = "This job's sandbox is gone, so there is no T3 to open.";

/**
 * A one-time pairing link to the T3 in a running job's sandbox, on the sandbox's encrypted tunnel.
 * A hibernated job is not woken for it. The link is returned for the intent's result only.
 */
export async function openT3(jobId: JobId): Promise<PairingResult> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return { refused: `No job ${jobId}.` };
  if (isHibernated(job)) return { refused: HIBERNATED_MESSAGE };
  if (!job.sandbox_id) return { refused: "This job does not run in a Modal sandbox." };
  try {
    const tunnel = await tunnelUrl(job.sandbox_id, T3_PORT);
    switch (tunnel.kind) {
      case "url":
        return await pairT3(modalHost(job.sandbox_id), tunnel.url);
      case "no port":
        return { refused: "This sandbox started before T3 was reachable from outside it. It will be once it hibernates and wakes again." };
      case "not ready":
        return { refused: "The sandbox's T3 isn't reachable yet; try again in a moment." };
      default: {
        const never: never = tunnel;
        throw new Error(`unknown tunnel ${JSON.stringify(never)}`);
      }
    }
  } catch (error) {
    if (error instanceof HostGoneError) return { refused: SANDBOX_GONE };
    throw error;
  }
}

/** Sandboxes and slots the last reap found without an owner; a second sighting acts, so a launch in flight is never hit. */
const suspects = { sandboxes: new Set<string>(), slots: new Set<string>() };

/**
 * Cleans up after crashes. A running sandbox of this runner's label (and machine, when tagged)
 * that no job points at is terminated; its login cannot go back, since no job names its slot. A
 * slot held by a job of this machine with no pending launch and no running sandbox is freed.
 */
export async function reap() {
  const machine = await thisMachine();
  const listed = await modal.api.list(config.factory.sandbox.appName, { label: config.factory.label });
  const running = new Set(listed.map((s) => s.sandboxId));
  const ours = listed.filter((s) => !s.tags.machine || s.tags.machine === machine.id).map((s) => s.sandboxId);
  const owned = new Set(
    ours.length > 0 ? (await db.select({ sandbox_id: jobs.sandbox_id }).from(jobs).where(inArray(jobs.sandbox_id, ours))).map((r) => r.sandbox_id) : [],
  );
  const orphans = ours.filter((id) => !owned.has(id));
  const terminated: string[] = [];
  for (const id of orphans.filter((id) => suspects.sandboxes.has(id))) {
    await terminateSandbox(id);
    terminated.push(id);
  }
  suspects.sandboxes = new Set(orphans.filter((id) => !terminated.includes(id)));

  const holders = await db
    .select({ key: jobs.key, sandbox_id: jobs.sandbox_id, codex_slot: jobs.codex_slot })
    .from(jobs)
    .where(and(eq(jobs.machine_id, machine.id), isNotNull(jobs.codex_slot), notPending));
  const idle = holders.filter((h) => !h.sandbox_id || !running.has(h.sandbox_id));
  const freed: string[] = [];
  for (const holder of idle.filter((h) => suspects.slots.has(`${h.key}:${h.codex_slot}`))) {
    const [cleared] = await db
      .update(jobs)
      .set({ codex_slot: null })
      .where(and(eq(jobs.key, holder.key), eq(jobs.codex_slot, holder.codex_slot!), sql`${jobs.sandbox_id} is not distinct from ${holder.sandbox_id}`, notPending))
      .returning({ key: jobs.key });
    if (cleared) freed.push(`${holder.key}:${holder.codex_slot}`);
  }
  suspects.slots = new Set(idle.map((h) => `${h.key}:${h.codex_slot}`).filter((id) => !freed.includes(id)));
  if (terminated.length > 0 || freed.length > 0) log("sandbox:reaped", { terminated, freed });
  return { terminated, freed, suspects: suspects.sandboxes.size + suspects.slots.size };
}

/** Whether this machine has anything on Modal to look after, so a runner that never used it never calls Modal. */
async function usesModal() {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(jobs).where(and(await mine(), holdsSandbox));
  return count > 0 || resolveExecution(await readSettings(db)) === "modal";
}

let lastReap = 0;

/** The timer's sandbox pass; each step on its own, so one failing does not skip the rest. */
export async function tickSandboxes(now = Date.now()) {
  const reapDue = now - lastReap >= REAP_EVERY_MS && (await usesModal());
  const reaped = reapDue ? await isolated(reap) : undefined;
  if (reaped && !("error" in reaped)) lastReap = now;
  return {
    settled: await isolated(settleInterrupted),
    tornDown: await isolated(teardownFinished),
    hibernated: await isolated(() => hibernateIdle(now)),
    tokens: await isolated(() => refreshTokens(now)),
    ...(reaped && { reaped }),
  };
}
