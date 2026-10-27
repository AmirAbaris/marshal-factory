import { z } from "zod";
import type { ExecError } from "../lib/exec";
import type { RepoName } from "../lib/github/app";
import { HostGoneError, hosts, localHost, type JobHost } from "../lib/host";
import { terminateSandbox } from "../lib/modal-host";
import { imageProblem, REPO_DIR } from "../lib/sandbox";
import { PENDING } from "./binding";
import { thisMachine } from "./heartbeat";
import type { JobSource } from "../lib/sources/types";
import type { Execution } from "../lib/execution";
import type { HarnessChoice } from "../lib/settings";
import { routeRepo, withRepoDefaults } from "../lib/repositories";
import { ticketLabels, type TicketRecord } from "../lib/ticket-overrides";
import {
  bindThread,
  claimLaunch,
  config,
  factoryCheckouts,
  launchSettings,
  leaseCodexSlot,
  machineInFlight,
  pendingLaunches,
  recordHarness,
  recordSandbox,
  releaseLaunch,
  sandboxesInFlight,
  toLaunch,
  withLocalImages,
  type LaunchSlot,
} from "./ops";
import { loginFailed, noteTokenWritten, retireSandbox } from "./lifecycle";
import { announceFallbacks, capabilities, overrideRuntime, planLaunch, splitByExecution } from "./overrides";
import { CodexLoginError, createJobSandbox, ingestConfig, sandboxHarness, sandboxRuntime, setupSandbox, usableSlots } from "./sandbox";

const sh = async (host: JobHost, cmd: string, args: string[], cwd?: string) =>
  (await host.run(cmd, args, { cwd, timeoutMs: 60_000 })).stdout.trim();

/** Thrown when T3 may have created the thread even though the start did not report it. */
export class MaybeStartedError extends Error {}

export function parseThreadId(stdout: string) {
  try {
    return z.object({ threadId: z.string() }).parse(JSON.parse(stdout)).threadId;
  } catch {
    throw new MaybeStartedError(`t3 thread start printed no thread id: ${stdout.slice(0, 200)}`);
  }
}

export async function startThread(host: JobHost, repo: string, branch: string, title: string, message: string, { provider, model }: HarnessChoice) {
  const { stdout } = await host.run(
    host.t3,
    [
      "thread", "start", repo, "-",
      "--worktree", "origin/main",
      "--branch", branch,
      "--title", title,
      "--provider", provider,
      "--model", model,
      "--json",
    ],
    { input: message, timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return parseThreadId(stdout);
}

/** T3 prepares the worktree after start returns; wait for it and confirm it sits on fresh origin/main. */
async function worktreeHead(threadId: string, host: JobHost) {
  for (let i = 0; i < 30; i++) {
    const { thread } = z
      .object({ thread: z.object({ worktreePath: z.string().nullable() }) })
      .parse(JSON.parse(await sh(host, host.t3, ["thread", "show", threadId, "--json"])));
    if (thread.worktreePath) {
      try {
        return { path: thread.worktreePath, head: await sh(host, "git", ["rev-parse", "HEAD"], thread.worktreePath) };
      } catch {
        // The directory exists before git has finished checking it out.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}

const PENDING_STALE_MS = 120_000;
/** A sandbox launch creates, clones and starts T3 before its thread exists, so its marker stays fresh longer. */
const SANDBOX_PENDING_STALE_MS = 15 * 60_000;
/** A stale sandbox launch whose T3 still cannot answer after this is given up: the sandbox ends with any thread in it. */
const SANDBOX_GIVE_UP_MS = 45 * 60_000;

/**
 * A launch that died between starting the thread and recording it leaves a pending marker. Once
 * it is stale, look for the thread T3 made on that branch and record it, or clear the marker.
 */
async function threadBranches(checkout: string, host: JobHost) {
  const list = z.array(z.object({ threadId: z.string() })).parse(JSON.parse(await sh(host, host.t3, ["thread", "list", "--project", checkout, "--json"])));
  return Promise.all(
    list.map(async ({ threadId }) => ({
      threadId,
      branch: z.object({ thread: z.object({ branch: z.string().nullable() }) }).parse(JSON.parse(await sh(host, host.t3, ["thread", "show", threadId, "--json"]))).thread.branch,
    })),
  );
}

type PendingLaunch = Awaited<ReturnType<typeof pendingLaunches>>[number];
const inSandbox = (p: { sandbox_id: string | null; codex_slot: string | null }) => p.sandbox_id !== null || p.codex_slot !== null;

/** Ends a launch that made no thread: its sandbox first, so a cleared row never points at a live one. */
export async function releaseSandboxLaunch(key: string, marker: string, sandboxId: string | null, slot: string | null) {
  if (sandboxId) await retireSandbox(key, sandboxId, slot);
  await releaseLaunch(key, marker);
}

/**
 * A sandbox that is gone has no thread; one whose T3 cannot answer keeps its marker for the next
 * pass, until SANDBOX_GIVE_UP_MS. Then it ends, and any thread in it with it, so the job relaunches.
 */
async function recoverSandbox(p: PendingLaunch) {
  let found: { threadId: string } | undefined;
  if (p.sandbox_id) {
    try {
      found = (await threadBranches(REPO_DIR, hosts.forJob(p))).find((b) => b.branch === p.branch);
    } catch (error) {
      if (!(error instanceof HostGoneError)) {
        const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
        if (Date.now() - markedAt(p.marker) <= SANDBOX_GIVE_UP_MS) return { key: p.key, error: reason, retry: "next pass" };
        await releaseSandboxLaunch(p.key, p.marker, p.sandbox_id, p.codex_slot);
        return { key: p.key, threadId: null, gaveUp: reason };
      }
    }
  }
  await (found ? bindThread(p.key, found.threadId) : releaseSandboxLaunch(p.key, p.marker, p.sandbox_id, p.codex_slot));
  return { key: p.key, threadId: found?.threadId ?? null };
}

const markedAt = (marker: string) => Number(marker.slice(PENDING.length));

export async function recoverPending(checkouts: ReadonlyMap<string, string>) {
  // A local pending launch whose repo left this machine's config has no project to look in; it waits for the repo to come back.
  // A sandbox launch looks in its sandbox, so it needs no checkout here.
  const stale = (await pendingLaunches()).filter(
    (p) => (inSandbox(p) || checkouts.has(p.repo)) && Date.now() - markedAt(p.marker) > (inSandbox(p) ? SANDBOX_PENDING_STALE_MS : PENDING_STALE_MS),
  );
  type Branches = Awaited<ReturnType<typeof threadBranches>>;
  const branchesByHost = new Map<JobHost, Map<string, Branches>>();
  const recovered = [];
  for (const p of stale) {
    if (inSandbox(p)) {
      recovered.push(await recoverSandbox(p));
      continue;
    }
    const host = hosts.forJob(p);
    if (!branchesByHost.has(host)) branchesByHost.set(host, new Map());
    const byRepo = branchesByHost.get(host)!;
    if (!byRepo.has(p.repo)) byRepo.set(p.repo, await threadBranches(checkouts.get(p.repo)!, host));
    const found = byRepo.get(p.repo)!.find((b) => b.branch === p.branch);
    // bindThread delivers an owed stop. Without a thread, clearing the marker leaves nothing owed.
    await (found ? bindThread(p.key, found.threadId) : releaseLaunch(p.key, p.marker));
    recovered.push({ key: p.key, threadId: found?.threadId ?? null });
  }
  return recovered;
}

export type LaunchEntry = {
  key: string;
  sandbox_id: null;
  attempt: number;
  budgetUsd: number;
  source: JobSource;
  repo: string;
  branch: string;
  threadTitle: string;
  message: string;
  /** The harness this job's plan chose; a sandbox may still map it to one it has. */
  harness: HarnessChoice;
  ticket: TicketRecord | null;
};

/** Runs once a launch holds the job, before its thread starts. */
type Claimed = (entry: LaunchEntry) => Promise<void>;

export type LaunchDeps = {
  claim: (key: string, marker: string) => Promise<boolean>;
  start: (entry: LaunchEntry) => Promise<string>;
  bind: (key: string, threadId: string) => Promise<unknown>;
  release: (key: string, marker: string) => Promise<unknown>;
  now: () => number;
};

/**
 * Whether a failed start may still have made the thread. Only a start that never ran (ENOENT)
 * or exited non-zero with its input fully written counts as a clear failure; a timeout, a broken
 * stdin pipe or unparsable output is ambiguous, and the pending marker is kept for recovery.
 */
export function maybeStarted(error: unknown) {
  if (error instanceof MaybeStartedError) return true;
  const failure = error as ExecError;
  if (failure?.code === "ENOENT") return false;
  return Boolean(failure?.killed || failure?.stdinError);
}

/**
 * Launches each entry on its own: a failure is logged and the rest still launch. A start that
 * clearly failed releases its marker so the next pass retries it; one that timed out keeps the
 * marker for recoverPending, which attaches the thread T3 made or clears the marker.
 */
export async function launchEntries(entries: readonly LaunchEntry[], deps: LaunchDeps) {
  const results: Record<string, unknown>[] = [];
  for (const entry of entries) {
    const marker = `${PENDING}${deps.now()}`;
    if (!(await deps.claim(entry.key, marker))) continue;
    const startedAt = deps.now();
    try {
      const threadId = await deps.start(entry);
      await deps.bind(entry.key, threadId);
      results.push({ key: entry.key, threadId, branch: entry.branch, startMs: deps.now() - startedAt });
    } catch (error) {
      const timedOut = maybeStarted(error);
      if (!timedOut) await deps.release(entry.key, marker);
      results.push({
        key: entry.key,
        error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        retry: timedOut ? "after launch recovery" : "next pass",
      });
    }
  }
  return results;
}

/**
 * Starts a T3 thread for every queued job no machine holds, each where its plan says: on this
 * machine or in a Modal sandbox, with the ticket's overrides over the settings. Each launch is
 * claimed with a pending marker first, so a crash or timeout after T3 created the thread can never
 * start a second one on the same branch, and another machine can never start the same job.
 */
export async function launchQueued(onWorktree: (check: Record<string, unknown>) => void = () => {}) {
  const [checkouts, registry] = await Promise.all([factoryCheckouts(), overrideRuntime.registry()]);
  // A registered repo without a checkout here can still launch in a Modal sandbox, which clones it from GitHub.
  const repos = [...new Set([...checkouts.keys(), ...registry.map((r) => r.repo)])];
  if (repos.length === 0) return [];
  const recovered = await recoverPending(checkouts);
  const machine = await thisMachine();
  if ((await machineInFlight(machine.id)) >= config.factory.maxInFlight) return recovered;
  const queued = (await toLaunch()).filter((entry) => repos.includes(entry.repo));
  if (queued.length === 0) return recovered;
  const slot = { id: machine.id, repos, maxInFlight: config.factory.maxInFlight };
  const settings = await launchSettings();
  const harnesses = await overrideRuntime.harnesses();
  const can = capabilities();
  const planned: (LaunchEntry & { execution: Execution })[] = [];
  const waiting: { key: string; reason: string }[] = [];
  const repoDefaults: { repo: string; problems: string[] }[] = [];
  for (const { job, ...entry } of queued) {
    const labels = ticketLabels(job.source_state);
    const { defaults, problems } = withRepoDefaults(settings, registry.find((r) => r.repo === job.repo), harnesses);
    if (problems.length > 0 && !repoDefaults.some((d) => d.repo === job.repo)) repoDefaults.push({ repo: job.repo, problems });
    const plan = planLaunch(labels, defaults, harnesses, { ...can, checkout: checkouts.has(job.repo) });
    switch (plan.kind) {
      case "launch": {
        // The claim routed the job already; a Repository label that could not apply is told like any other fallback.
        const routed = routeRepo(labels, registry).problem;
        const ticket = routed ? { ...plan.ticket, notes: [routed, ...(plan.ticket?.notes ?? [])] } : plan.ticket;
        planned.push({ ...entry, harness: plan.harness, ticket, execution: plan.execution });
        break;
      }
      case "wait":
        waiting.push({ key: entry.key, reason: plan.reason });
        break;
      default: {
        const never: never = plan;
        throw new Error(`unknown plan ${String(never)}`);
      }
    }
  }
  if (waiting.length > 0) overrideRuntime.log("override:waiting", { waiting });
  if (repoDefaults.length > 0) overrideRuntime.log("repo:default-skipped", { repos: repoDefaults });
  const noCheckout = planned.filter((p) => p.execution === "modal" && !checkouts.has(p.repo) && !p.ticket?.execution).map((p) => p.key);
  if (noCheckout.length > 0) overrideRuntime.log("repo:no-checkout", { modal: noCheckout });
  const jobs = new Map(queued.map((q) => [q.key, q.job]));
  const claimed: Claimed = (entry) => announceFallbacks(jobs.get(entry.key)!, entry.ticket);
  const { local, modal } = splitByExecution(planned);
  return [
    ...recovered,
    ...(local.length > 0 ? await launchLocal(local, checkouts, slot, claimed, onWorktree) : []),
    ...(modal.length > 0 ? await launchInSandboxes(modal, slot, claimed) : []),
  ];
}

/** In this machine's checkout of the job's repo, on a worktree cut from freshly fetched origin/main. */
async function launchLocal(
  pending: readonly LaunchEntry[],
  checkouts: ReadonlyMap<string, string>,
  slot: LaunchSlot,
  claimed: Claimed,
  onWorktree: (check: Record<string, unknown>) => void,
) {
  const byKey = new Map(pending.map((entry) => [entry.key, entry]));
  const origins = new Map<string, string>();
  for (const repo of new Set(pending.map((entry) => entry.repo))) {
    const checkout = checkouts.get(repo)!;
    await sh(localHost, "git", ["fetch", "origin", "--prune"], checkout);
    origins.set(repo, await sh(localHost, "git", ["rev-parse", "origin/main"], checkout));
  }
  const launched = await launchEntries(pending, {
    async claim(key, marker) {
      const entry = byKey.get(key)!;
      if (!(await claimLaunch(key, marker, slot, entry.harness, { execution: "local", ticket: entry.ticket }))) return false;
      await claimed(entry);
      return true;
    },
    // After the claim, so a job another machine wins downloads nothing here.
    start: async (entry) =>
      startThread(hosts.forJob(entry), checkouts.get(entry.repo)!, entry.branch, entry.threadTitle, await withLocalImages(entry.source, entry.key, entry.message), entry.harness),
    bind: bindThread,
    release: releaseLaunch,
    now: Date.now,
  });
  // Diagnostic only and up to 30 s per thread, so it runs off the runner's queue.
  for (const result of launched) {
    if (typeof result.threadId !== "string") continue;
    const entry = pending.find((e) => e.key === result.key)!;
    const origin = origins.get(entry.repo)!;
    void worktreeHead(result.threadId, hosts.forJob(entry))
      .then((tree) => onWorktree({ key: result.key, worktree: tree?.path, freshFromOrigin: tree ? tree.head === origin : undefined, originMain: origin.slice(0, 7) }))
      .catch((error: unknown) => onWorktree({ key: result.key, error: String(error) }));
  }
  return launched;
}

/** Thrown for a setup step that failed before T3 was asked for a thread, so no thread can exist. */
class SandboxSetupError extends Error {}

/**
 * One Modal sandbox per job, each holding its own Codex login slot, at most maxParallel at once. A
 * launch records the sandbox and the slot on the job before anything runs in it, so a crash leaves
 * them findable. A failure before the thread start ends the sandbox and frees the slot; a start
 * that may have made the thread keeps both for launch recovery, which asks the sandbox's T3.
 */
export async function launchInSandboxes(pending: readonly LaunchEntry[], slot: LaunchSlot, claimed: Claimed = async () => {}) {
  const limits = config.factory.sandbox;
  const runtime = sandboxRuntime;
  const image = runtime.image();
  const problem = imageProblem(image, limits);
  if (problem || !image) {
    runtime.log("sandbox:no-image", { queued: pending.map((e) => e.key), reason: problem });
    return [];
  }
  const claudeToken = runtime.claudeToken();
  const byKey = new Map(pending.map((entry) => [entry.key, entry]));
  let room = limits.maxParallel - (await sandboxesInFlight(slot.id));
  const leases = new Map<string, { marker: string; slot: string; choice: HarnessChoice }>();
  return launchEntries(pending, {
    async claim(key, marker) {
      if (room <= 0) return false;
      const entry = byKey.get(key)!;
      const { choice, fallback } = sandboxHarness(entry.harness, runtime.driverOf(entry.harness.provider), Boolean(claudeToken), limits.codexModel);
      if (!(await claimLaunch(key, marker, slot, choice, { execution: "modal", ticket: entry.ticket }))) return false;
      const codexSlot = await leaseCodexSlot(key, marker, usableSlots(limits));
      if (!codexSlot) {
        await releaseLaunch(key, marker);
        runtime.log("sandbox:no-slot", { key, slots: limits.codexSlots.length });
        return false;
      }
      room--;
      leases.set(key, { marker, slot: codexSlot, choice });
      if (fallback) runtime.log("sandbox:harness-fallback", { key, reason: fallback });
      await claimed(entry);
      return true;
    },
    async start(entry) {
      const lease = leases.get(entry.key)!;
      let host: JobHost;
      let ran: HarnessChoice;
      try {
        const codexAuth = runtime.slotAuth(lease.slot);
        const githubToken = await runtime.githubToken(entry.repo as RepoName);
        const created = await createJobSandbox({
          key: entry.key,
          attempt: entry.attempt,
          label: config.factory.label,
          machineId: slot.id,
          imageId: image.imageId,
          limits,
          claudeToken,
        });
        try {
          await recordSandbox(entry.key, lease.marker, created.sandboxId);
        } catch (error) {
          await terminateSandbox(created.sandboxId);
          throw error;
        }
        host = created.host;
        const setup = { repo: entry.repo, choice: lease.choice, hasClaude: Boolean(claudeToken), slot: lease.slot, codexAuth, githubToken, ingest: ingestConfig(config, entry.budgetUsd) };
        const outcome = await setupSandbox(host, setup, limits.codexModel);
        noteTokenWritten(created.sandboxId);
        ran = outcome.choice;
        if (outcome.fallback) {
          await recordHarness(entry.key, lease.marker, ran);
          runtime.log("sandbox:harness-fallback", { key: entry.key, reason: outcome.fallback });
        }
      } catch (error) {
        if (error instanceof CodexLoginError) await loginFailed(entry.key, error.slot);
        throw new SandboxSetupError(`sandbox setup failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
      }
      // Images stay on this machine for now; the thread gets the issue text with their links.
      return startThread(host, REPO_DIR, entry.branch, entry.threadTitle, entry.message, ran);
    },
    bind: bindThread,
    release: async (key, marker) => {
      const [row] = (await pendingLaunches()).filter((p) => p.key === key && p.marker === marker);
      await releaseSandboxLaunch(key, marker, row?.sandbox_id ?? null, row?.codex_slot ?? null);
      room++;
    },
    now: Date.now,
  });
}
