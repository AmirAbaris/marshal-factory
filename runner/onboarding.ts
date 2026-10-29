import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { repoSettings, type RepoSettingsRow } from "../db/schema";
import type { RepoName } from "../lib/github/app";
import { fileOnDefaultBranch } from "../lib/github/installation";
import { github } from "../lib/github/pulls";
import { HostGoneError, type JobHost } from "../lib/host";
import { createSandbox, deleteSnapshot, modal, modalHost, rememberSandbox, terminateSandbox } from "../lib/modal-host";
import {
  afterRecipe,
  bugbotVerdict,
  checkResultSchema,
  imageOutdated,
  modalSecretName,
  parseDetail,
  type BaseImage,
  type CheckResult,
  type OnboardingDetail,
  type OnboardingRun,
  type OnboardingState,
} from "../lib/onboarding";
import {
  BUILD_DIR,
  BUILD_EXIT,
  BUILD_FILES,
  buildScript,
  parseCheckResults,
  parseRecipe,
  RECIPE_PATH,
  recipeSchema,
  redact,
  warmKeyOf,
  warmKeyTouched,
  type Recipe,
} from "../lib/recipe";
import { recipeHash, sha256 } from "../lib/recipe-hash";
import { builtVersions, GITHUB_TOKEN_PATH, imageProblem, REPO_DIR, type SandboxImage } from "../lib/sandbox";
import { matchesAny } from "../lib/globs";
import type { RepoPushDetail } from "../lib/webhooks";
import { config } from "./config";
import { thisMachine } from "./heartbeat";
import { startThread } from "./launch";
import { launchSettings } from "./ops";
import { leasedSlots, loginFailed, TOKEN_REFRESH_MS, uniqueViolation, writeBackLogin } from "./lifecycle";
import { CodexLoginError, sandboxHarness, sandboxRuntime, sandboxSecrets, setupSandbox, usableSlots, writeGithubToken } from "./sandbox";
import { threads } from "./threads";

// Runs a repo's onboarding on Modal, tracked on its registry row rather than as a job. Each step is
// short and the tick advances it, so nothing long ever holds the runner's queue:
//
//   onboard   main has a valid recipe: take it (its checks run in the image build). Otherwise an
//             agent run: a sandbox from the base image, T3 started as for a job, one thread on the
//             Settings harness with playbooks/onboarding.md, which commits the recipe on
//             factory/onboarding, opens its PR and writes ONBOARDING_RESULT
//   agent     the tick waits for the thread to settle, reads the result, hands the login back and
//             ends the sandbox; the recipe then needs secrets (needs_input) or goes to building
//   build     a sandbox from the base image clones origin/main, installs and sets up in the
//             background; once it exits 0 the token and the build files go, the filesystem is
//             snapshotted to the repo's warm image, and the old image is deleted
//
// One build at a time per machine. A push that touches the recipe or its warmKey, a base image
// rebuilt or re-pinned, or the owner's Rebuild image starts another; the old image serves meanwhile.

export const ONBOARDING_BRANCH = "factory/onboarding";
export const ONBOARDING_RESULT = `${BUILD_DIR}/result.json`;
const AGENT_GIVE_UP_MS = 90 * 60_000;
/** An agent run on another machine still without a sandbox after this died before creating it. */
const LEASING_GIVE_UP_MS = 30 * 60_000;
const BUILD_GIVE_UP_MS = 45 * 60_000;
const PLAYBOOK = join(import.meta.dirname, "../playbooks/onboarding.md");

const log = (event: string, detail: Record<string, unknown>) => sandboxRuntime.log(event, detail);
const message = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : String(error));

/** What onboarding reads from outside the database; regressions replace any of it. */
export const onboardingRuntime = {
  committedRecipe: (repo: string): Promise<string | null> => fileOnDefaultBranch(repo as RepoName, RECIPE_PATH),
  bugbotRan: (prUrl: string): Promise<boolean> => github.bugbotRan(prUrl),
  playbook: () => readFileSync(PLAYBOOK, "utf8"),
  now: () => new Date(),
};

const resultSchema = z.union([
  z.object({ recipe: recipeSchema, prUrl: z.string().nullable().optional(), checks: z.array(checkResultSchema).optional(), summary: z.string().optional() }),
  z.object({ failed: z.string() }),
]);

type Change = { state?: OnboardingState | null; detail: OnboardingDetail };
type StartedRun = OnboardingRun & { sandboxId: string };
const hasSandbox = (run: OnboardingRun): run is StartedRun => run.sandboxId !== undefined;

/** Repos whose agent run this runner is creating a sandbox for. */
const starting = new Set<string>();

/** Reads the row under a lock and writes what `change` returns; null leaves it as it is. */
async function update(repo: string, change: (row: RepoSettingsRow, detail: OnboardingDetail) => Change | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(repoSettings).where(eq(repoSettings.repo, repo)).for("update");
    if (!row) return null;
    const next = change(row, parseDetail(row.onboarding_detail));
    if (!next) return null;
    const state = next.state === undefined ? row.onboarding_state : next.state;
    const at = onboardingRuntime.now();
    await tx
      .update(repoSettings)
      .set({ onboarding_detail: next.detail, onboarding_state: state, ...(state !== row.onboarding_state && { onboarding_at: at }) })
      .where(eq(repoSettings.repo, repo));
    return { ...row, onboarding_state: state, onboarding_detail: next.detail };
  });
}

const failure = (reason: string, logText?: string) => ({ reason, ...(logText && { log: logText }), at: onboardingRuntime.now().toISOString() });

async function fail(repo: string, reason: string, logText?: string) {
  log("onboarding:failed", { repo, reason });
  await update(repo, (_row, detail) => ({ state: "failed", detail: { ...detail, run: undefined, failure: failure(reason, logText) } }));
  return { repo, failed: reason };
}

/** Ends the run's sandbox, handing an agent's login back to its slot first, and clears the run. */
async function endRun(repo: string, run: StartedRun) {
  if (run.slot) await writeBackLogin(`onboard:${repo}`, run.sandboxId, run.slot);
  await terminateSandbox(run.sandboxId);
  await update(repo, (_row, detail) => (detail.run?.sandboxId === run.sandboxId ? { detail: { ...detail, run: undefined } } : null));
}

const baseOf = (image: SandboxImage): BaseImage => ({ versions: builtVersions(image), builtAt: image.builtAt });

/** The base image when this runner can start onboarding sandboxes from it, else why not. */
function launchable(): { image: SandboxImage } | { problem: string } {
  const image = sandboxRuntime.image();
  const problem = imageProblem(image, config.factory.sandbox) ?? (!sandboxRuntime.modalToken() ? "there is no cloud sandbox token on this runner" : undefined);
  return problem || !image ? { problem: problem ?? "no sandbox image is built" } : { image };
}

const sandboxNameFor = (repo: string, kind: OnboardingRun["kind"], at: number) =>
  `onboard-${kind}-${repo.replace("/", "-")}-${at}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 63);

export const ONBOARDING_TAGS = (machine: string) => ({ purpose: "onboarding", factory: config.factory.label, machine });

/** A sandbox for one onboarding step, tagged so the onboarding reap can find it; never one the job reap touches. */
async function onboardingSandbox(repo: string, kind: OnboardingRun["kind"], imageId: string, namedSecrets: string[]) {
  const machine = await thisMachine();
  const sandbox = await createSandbox({
    name: sandboxNameFor(repo, kind, Date.now()),
    tags: { ...ONBOARDING_TAGS(machine.id), repo },
    imageId,
    secrets: kind === "agent" ? sandboxSecrets(sandboxRuntime.claudeToken()) : {},
    namedSecrets,
    env: { IS_SANDBOX: "1" },
    encryptedPorts: [],
    limits: config.factory.sandbox,
  });
  rememberSandbox(sandbox);
  return { sandboxId: sandbox.sandboxId, host: modalHost(sandbox.sandboxId), machine: machine.id };
}

/** Records the run on the row unless another one is there; false means the sandbox must go. */
async function claimRun(repo: string, run: OnboardingRun, state?: OnboardingState) {
  const claimed = await update(repo, (_row, detail) => {
    if (detail.run) return null;
    // A build takes on the wanted rebuild, so one wanted while it runs is a new one.
    const taken = run.kind === "build" && detail.rebuild ? { ...run, reason: detail.rebuild.reason } : run;
    return { ...(state && { state }), detail: { ...detail, run: taken, failure: undefined, ...(run.kind === "build" && { rebuild: undefined }) } };
  });
  return claimed !== null;
}

const secretsFor = (repo: string, detail: OnboardingDetail) => ((detail.secretsSet ?? []).length > 0 ? [modalSecretName(repo)] : []);

/**
 * Records an agent run holding a free Codex login slot, before its sandbox exists. The trigger on
 * repo_settings leases the slot in the same write, so a lease never outlives its run: clearing
 * the run frees it. "taken" when another run is on the row; undefined when every slot is held.
 */
async function claimSlot(repo: string, machine: string): Promise<OnboardingRun | "taken" | undefined> {
  const held = await leasedSlots();
  for (const slot of usableSlots(config.factory.sandbox).filter((s) => !held.has(s))) {
    const run: OnboardingRun = { kind: "agent", machine, startedAt: onboardingRuntime.now().toISOString(), slot };
    try {
      return (await claimRun(repo, run, "analyzing")) ? run : "taken";
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
    }
  }
  return undefined;
}

/** The same agent run, still waiting for its sandbox. */
const sameLeasing = (a: OnboardingRun | undefined, b: OnboardingRun) =>
  a !== undefined && a.sandboxId === undefined && a.kind === b.kind && a.machine === b.machine && a.startedAt === b.startedAt && a.slot === b.slot;

/**
 * An agent run this runner recorded but has no start going for: it restarted while creating the
 * sandbox. The onboard_repo intent that started it was never recorded, so its retry starts over.
 */
const leftBehind = (repo: string, run: OnboardingRun, machine: string) => !hasSandbox(run) && run.machine === machine && !starting.has(repo);

const clearLeasing = (repo: string, run: OnboardingRun, state?: OnboardingState, reason?: string) =>
  update(repo, (_r, d) => (sameLeasing(d.run, run) ? { ...(state && { state }), detail: { ...d, run: undefined, ...(reason && { failure: failure(reason) }) } } : null));

/** The recipe is known: record it with what came along, then secrets, then the image. */
async function applyRecipe(repo: string, recipe: Recipe, extra: Partial<OnboardingDetail>) {
  const updated = await update(repo, (_row, detail) => {
    const next = { ...detail, ...extra, recipe, failure: undefined };
    const { state, missingSecrets } = afterRecipe(recipe, next);
    return { state, detail: { ...next, missingSecrets } };
  });
  log("onboarding:recipe", { repo, source: extra.recipeSource, state: updated?.onboarding_state });
  return updated?.onboarding_state ?? null;
}

function agentMessage(repo: string, detail: OnboardingDetail, committedError: string | undefined) {
  return [
    `Onboard ${repo} to marshal-factory: write its setup recipe, ${RECIPE_PATH}, prove it, and open a pull request with it.`,
    "",
    `This is an unattended onboarding run. Follow the playbook below. The repo is cloned at ${REPO_DIR}; your worktree is on branch ${ONBOARDING_BRANCH}. Write the result to ${ONBOARDING_RESULT} last, then end the turn.`,
    ...(committedError ? ["", `main already has a ${RECIPE_PATH}, but the factory cannot use it: ${committedError} Fix it in your recipe.`] : []),
    ...((detail.secretsSet ?? []).length > 0 ? ["", `These env vars have values in this sandbox already: ${detail.secretsSet!.join(", ")}.`] : []),
    "",
    onboardingRuntime.playbook(),
  ].join("\n");
}

/**
 * Starts onboarding a repo: main's recipe when it has a valid one, else an agent run that writes
 * one. A runner that cannot start sandboxes says why on the row; the owner retries from the panel.
 */
export async function onboardRepo(repo: string) {
  const [row] = await db.select().from(repoSettings).where(eq(repoSettings.repo, repo));
  if (!row) return { repo, skipped: "not registered" };
  const detail = parseDetail(row.onboarding_detail);
  if (detail.run && !(leftBehind(repo, detail.run, (await thisMachine()).id) && (await clearLeasing(repo, detail.run)))) {
    return { repo, skipped: `${detail.run.kind === "agent" ? "an agent" : "a build"} run is in flight` };
  }
  if (row.onboarding_state !== "analyzing") await update(repo, (_r, d) => ({ state: "analyzing", detail: { ...d, failure: undefined } }));
  const committed = await onboardingRuntime.committedRecipe(repo);
  const parsed = committed === null ? null : parseRecipe(committed);
  if (parsed?.ok) {
    const state = await applyRecipe(repo, parsed.recipe, { recipeSource: "committed", checks: undefined, summary: undefined });
    return { repo, recipe: "committed", state, builds: await startBuilds() };
  }
  return startAgent(repo, parsed && !parsed.ok ? parsed.error : undefined);
}

async function startAgent(repo: string, committedError: string | undefined) {
  const base = launchable();
  if ("problem" in base) return fail(repo, `The onboarding cloud sandbox cannot start: ${base.problem}.`);
  starting.add(repo);
  try {
    const leasing = await claimSlot(repo, (await thisMachine()).id);
    if (leasing === "taken") return { repo, skipped: "another run started" };
    if (!leasing) throw new Error("no free Codex login slot for the onboarding run; it retries");
    const created = await agentSandbox(repo, leasing, base.image).catch(async (error: unknown) => {
      await clearLeasing(repo, leasing);
      throw error;
    });
    return created ? await runAgent(repo, created.run, created.host, committedError) : { repo, skipped: "another run started" };
  } finally {
    starting.delete(repo);
  }
}

/** The leasing run's sandbox, recorded on its run; undefined when the run was cleared meanwhile. */
async function agentSandbox(repo: string, leasing: OnboardingRun, image: SandboxImage) {
  const [row] = await db.select().from(repoSettings).where(eq(repoSettings.repo, repo));
  const created = await onboardingSandbox(repo, "agent", image.imageId, secretsFor(repo, parseDetail(row?.onboarding_detail)));
  const run: StartedRun = { ...leasing, sandboxId: created.sandboxId, tokenAt: onboardingRuntime.now().toISOString() };
  if (!(await update(repo, (_r, d) => (sameLeasing(d.run, leasing) ? { detail: { ...d, run } } : null)))) {
    await terminateSandbox(created.sandboxId);
    return undefined;
  }
  return { run, host: created.host };
}

async function runAgent(repo: string, run: StartedRun, host: JobHost, committedError: string | undefined) {
  const limits = config.factory.sandbox;
  const slot = run.slot!;
  try {
    const { harness } = await launchSettings();
    const claudeToken = sandboxRuntime.claudeToken();
    const { choice } = sandboxHarness(harness, sandboxRuntime.driverOf(harness.provider), Boolean(claudeToken), limits.codexModel);
    const [row] = await db.select().from(repoSettings).where(eq(repoSettings.repo, repo));
    const detail = parseDetail(row?.onboarding_detail);
    const githubToken = await sandboxRuntime.githubToken(repo as RepoName);
    const setup = { repo, choice, hasClaude: Boolean(claudeToken), codex: { slot, auth: sandboxRuntime.slotAuth(slot) }, githubToken, ingest: null };
    const outcome = await setupSandbox(host, setup, limits.codexModel);
    await host.run("mkdir", ["-p", BUILD_DIR], { timeoutMs: 30_000 });
    const threadId = await startThread(host, REPO_DIR, ONBOARDING_BRANCH, `Onboard ${repo}`, agentMessage(repo, detail, committedError), outcome.choice);
    await update(repo, (_r, d) => (d.run?.sandboxId === run.sandboxId ? { detail: { ...d, run: { ...run, threadId } } } : null));
    log("onboarding:agent-started", { repo, sandbox: run.sandboxId, threadId, harness: outcome.choice });
    return { repo, agent: threadId };
  } catch (error) {
    if (error instanceof CodexLoginError) await loginFailed(`onboard:${repo}`, error.slot);
    await endRun(repo, run);
    return fail(repo, `The onboarding sandbox could not start its agent: ${message(error)}`);
  }
}

async function refreshToken(repo: string, run: StartedRun, host: JobHost) {
  if (run.tokenAt && Date.now() - Date.parse(run.tokenAt) < TOKEN_REFRESH_MS) return;
  await writeGithubToken(host, await sandboxRuntime.githubToken(repo as RepoName));
  const tokenAt = onboardingRuntime.now().toISOString();
  await update(repo, (_r, d) => (d.run?.sandboxId === run.sandboxId ? { detail: { ...d, run: { ...run, tokenAt } } } : null));
}

const overdue = (run: OnboardingRun, limitMs: number) => Date.now() - Date.parse(run.startedAt) > limitMs;

async function advanceAgent(row: RepoSettingsRow, run: StartedRun) {
  const host = modalHost(run.sandboxId);
  const read = await threads.read(run.threadId ?? null, host);
  if (read.state === "running") {
    if (overdue(run, AGENT_GIVE_UP_MS)) {
      await endRun(row.repo, run);
      return fail(row.repo, `The onboarding agent was still running after ${AGENT_GIVE_UP_MS / 60_000} minutes, so the factory stopped it.`);
    }
    await refreshToken(row.repo, run, host);
    return undefined;
  }
  let text: string | null = null;
  try {
    text = await host.readFile(ONBOARDING_RESULT);
  } catch (error) {
    if (!(error instanceof HostGoneError)) throw error;
  }
  await endRun(row.repo, run);
  const envNames = (parseDetail(row.onboarding_detail).recipe?.env ?? []).map((e) => e.name);
  const said = read.lastMessage ? redact(read.lastMessage, envNames, 15) : undefined;
  if (text === null) return fail(row.repo, "The onboarding agent ended without writing its result.", said);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(row.repo, `The onboarding agent's result is not JSON.`, said);
  }
  const result = resultSchema.safeParse(json);
  if (!result.success) return fail(row.repo, `The onboarding agent's result has no valid recipe: ${result.error.issues[0]?.path.join(".")} ${result.error.issues[0]?.message}`, said);
  if ("failed" in result.data) return fail(row.repo, `The onboarding agent could not write a recipe: ${redact(result.data.failed, envNames, 5)}`, said);
  const { recipe, prUrl, checks, summary } = result.data;
  const state = await applyRecipe(row.repo, recipe, {
    recipeSource: "agent",
    ...(prUrl && { recipePr: prUrl, bugbotProbe: { pr: prUrl, since: onboardingRuntime.now().toISOString() } }),
    checks: checks as CheckResult[] | undefined,
    ...(summary && { summary: redact(summary, recipe.env?.map((e) => e.name) ?? [], 5) }),
  });
  return { repo: row.repo, recipe: "agent", prUrl, state };
}

/** In the sandbox: the token, the clone at origin/main, and the build script started in the background. */
export async function startImageBuild(host: JobHost, { repo, recipe, githubToken, checks }: { repo: string; recipe: Recipe; githubToken: string; checks: boolean }) {
  await host.run("mkdir", ["-p", BUILD_DIR], { timeoutMs: 30_000 });
  await writeGithubToken(host, githubToken);
  await host.run("git", ["clone", "--quiet", `https://github.com/${repo}.git`, REPO_DIR], { timeoutMs: 300_000 });
  await host.writeFile(BUILD_FILES.script, buildScript(recipe, REPO_DIR, { checks }));
  const code = BUILD_FILES.code;
  await host.run(
    "bash",
    ["-c", `nohup bash -c 'bash ${BUILD_FILES.script} > ${BUILD_FILES.log} 2>&1; echo $? > ${code}.tmp; mv ${code}.tmp ${code}' > /dev/null 2>&1 &`],
    { timeoutMs: 30_000 },
  );
}

export type BuildStatus = { done: false } | { done: true; code: number; log: string };

export async function imageBuildStatus(host: JobHost): Promise<BuildStatus> {
  const code = await host.readFile(BUILD_FILES.code);
  if (code === null) return { done: false };
  return { done: true, code: Number(code.trim()), log: (await host.readFile(BUILD_FILES.log)) ?? "" };
}

/**
 * After a build that exited 0: its commit, the hash of the files its warmKey matches, the check
 * results, then the token and the build files removed and the filesystem snapshotted for good.
 */
export async function finishImageBuild(host: JobHost, sandboxId: string, recipe: Recipe, checks: boolean) {
  const commit = (await host.run("git", ["-C", REPO_DIR, "rev-parse", "HEAD"], { timeoutMs: 30_000 })).stdout.trim();
  const files = (await host.run("git", ["-C", REPO_DIR, "ls-files"], { timeoutMs: 60_000, maxBuffer: 64 * 1024 * 1024 })).stdout
    .split("\n")
    .filter((f) => f && matchesAny(f, warmKeyOf(recipe)))
    .sort();
  const sums = files.length > 0 ? (await host.run("sha256sum", ["--", ...files], { cwd: REPO_DIR, timeoutMs: 60_000 })).stdout : "";
  const results = checks ? parseCheckResults(await host.readFile(BUILD_FILES.checks), recipe) : undefined;
  await host.run("rm", ["-rf", BUILD_DIR, GITHUB_TOKEN_PATH], { timeoutMs: 30_000 });
  const handle = await modal.api.fromId(sandboxId);
  const { imageId } = await handle.snapshotFilesystem({ timeoutMs: 240_000, ttlMs: null });
  return { imageId, commit, warmKeyHash: sha256(sums), checks: results };
}

async function startBuild(row: RepoSettingsRow, image: SandboxImage) {
  const detail = parseDetail(row.onboarding_detail);
  const recipe = detail.recipe!;
  const hash = recipeHash(recipe);
  // A committed recipe's checks run once per recipe; an agent's recipe was checked by the agent.
  const checks = detail.recipeSource === "committed" && detail.image?.recipeHash !== hash;
  const created = await onboardingSandbox(row.repo, "build", image.imageId, secretsFor(row.repo, detail));
  const now = onboardingRuntime.now().toISOString();
  const run: StartedRun = { kind: "build", machine: created.machine, sandboxId: created.sandboxId, startedAt: now, tokenAt: now, checks };
  if (!(await claimRun(row.repo, run))) {
    await terminateSandbox(created.sandboxId);
    return undefined;
  }
  try {
    await startImageBuild(created.host, { repo: row.repo, recipe, githubToken: await sandboxRuntime.githubToken(row.repo as RepoName), checks });
    log("onboarding:build-started", { repo: row.repo, sandbox: created.sandboxId, checks });
    return { repo: row.repo, build: created.sandboxId };
  } catch (error) {
    await endRun(row.repo, run);
    return fail(row.repo, `The image build could not start: ${message(error)}`);
  }
}

async function advanceBuild(row: RepoSettingsRow, run: StartedRun) {
  const host = modalHost(run.sandboxId);
  const detail = parseDetail(row.onboarding_detail);
  const recipe = detail.recipe!;
  let status: BuildStatus;
  try {
    status = await imageBuildStatus(host);
  } catch (error) {
    if (!(error instanceof HostGoneError)) throw error;
    await update(row.repo, (_r, d) => (d.run?.sandboxId === run.sandboxId ? { detail: { ...d, run: undefined } } : null));
    return fail(row.repo, "The image build's sandbox is gone; it may have hit its time limit.");
  }
  if (!status.done) {
    if (overdue(run, BUILD_GIVE_UP_MS)) {
      await endRun(row.repo, run);
      return fail(row.repo, `The image build was still running after ${BUILD_GIVE_UP_MS / 60_000} minutes, so the factory stopped it.`);
    }
    await refreshToken(row.repo, run, host);
    return undefined;
  }
  const envNames = (recipe.env ?? []).map((e) => e.name);
  if (status.code !== 0) {
    await endRun(row.repo, run);
    return fail(row.repo, `The image build failed: ${BUILD_EXIT[status.code] ?? `the build script exited ${status.code}`}.`, redact(status.log, envNames));
  }
  const base = sandboxRuntime.image();
  const finished = await finishImageBuild(host, run.sandboxId, recipe, Boolean(run.checks));
  const previous = detail.image?.id;
  const builtAt = onboardingRuntime.now().toISOString();
  const recorded = await update(row.repo, (_r, d) =>
    d.run?.sandboxId !== run.sandboxId
      ? null
      : {
          state: d.rebuild ? "rebuilding" : "ready",
          detail: {
            ...d,
            run: undefined,
            failure: undefined,
            ...(finished.checks && { checks: finished.checks }),
            image: {
              id: finished.imageId,
              builtAt,
              commit: finished.commit,
              base: base ? baseOf(base) : { versions: {}, builtAt: "" },
              recipeHash: recipeHash(recipe),
              warmKeyHash: finished.warmKeyHash,
            },
          },
        },
  );
  await terminateSandbox(run.sandboxId);
  if (!recorded) {
    await deleteSnapshot(finished.imageId);
    return { repo: row.repo, discarded: finished.imageId };
  }
  if (previous && previous !== finished.imageId) await deleteSnapshot(previous).catch((error: unknown) => log("onboarding:image-delete-failed", { repo: row.repo, image: previous, error: message(error) }));
  log("onboarding:image-built", { repo: row.repo, image: finished.imageId, commit: finished.commit.slice(0, 7) });
  return { repo: row.repo, image: finished.imageId, state: recorded.onboarding_state };
}

/** A rebuild of the repo's image from the recipe on its row, wanted by the owner or by a change. */
export async function requestRebuild(repo: string, reason: string) {
  const updated = await update(repo, (row, detail) => {
    if (!detail.recipe) return null;
    const { state, missingSecrets } = afterRecipe(detail.recipe, detail);
    // A build in flight finishes first; the wanted rebuild then starts from the row's recipe.
    return { state: detail.run?.kind === "agent" ? row.onboarding_state : state, detail: { ...detail, missingSecrets, rebuild: { reason, at: onboardingRuntime.now().toISOString() } } };
  });
  if (!updated) return { repo, skipped: "no recipe" };
  return { repo, state: updated.onboarding_state, builds: await startBuilds() };
}

/**
 * A push to a registered repo's default branch. One touching the recipe takes main's recipe; one
 * touching its warmKey rebuilds. A repo whose agent is still writing its recipe is left alone.
 */
export async function repoPushed(push: RepoPushDetail) {
  const [row] = await db.select().from(repoSettings).where(sql`lower(${repoSettings.repo}) = lower(${push.repo})`);
  if (!row?.onboarding_state) return { repo: push.repo, skipped: "not onboarded" };
  const detail = parseDetail(row.onboarding_detail);
  if (detail.run?.kind === "agent") return { repo: row.repo, skipped: "the onboarding agent is still running" };
  const recipeChanged = push.truncated || push.files.includes(RECIPE_PATH);
  if (!recipeChanged && !(detail.recipe && warmKeyTouched(detail.recipe, push.files))) return { repo: row.repo, skipped: "nothing the warm image depends on changed" };
  if (recipeChanged) {
    const text = await onboardingRuntime.committedRecipe(row.repo);
    const parsed = text === null ? null : parseRecipe(text);
    if (parsed?.ok) {
      const changed = !detail.recipe || recipeHash(parsed.recipe) !== recipeHash(detail.recipe) || detail.recipeSource !== "committed";
      if (changed) {
        await update(row.repo, (_r, d) => ({ detail: { ...d, recipe: parsed.recipe, recipeSource: "committed" } }));
        return requestRebuild(row.repo, "the recipe changed on main");
      }
    } else if (parsed && !parsed.ok) {
      return fail(row.repo, `main's ${RECIPE_PATH} is not a valid recipe: ${parsed.error}`);
    }
  }
  if (!detail.recipe) return { repo: row.repo, skipped: "no recipe yet" };
  return requestRebuild(row.repo, push.truncated ? "a push to main changed more than the factory can list" : recipeChanged ? "the recipe changed on main" : "dependencies changed on main");
}

/**
 * The next build this machine may start, one at a time: a repo waiting for its first or a wanted
 * image, else, lazily, a ready repo whose image no longer fits the base image.
 */
export async function startBuilds({ only }: { only?: readonly string[] } = {}) {
  const machine = await thisMachine();
  const rows = await db.select().from(repoSettings).where(onlyRepos(only)).orderBy(asc(repoSettings.onboarding_at));
  if (rows.some((r) => parseDetail(r.onboarding_detail).run?.kind === "build" && parseDetail(r.onboarding_detail).run?.machine === machine.id)) return undefined;
  const base = launchable();
  if ("problem" in base) return undefined;
  const ready = (r: RepoSettingsRow) => {
    const d = parseDetail(r.onboarding_detail);
    return r.enabled && d.recipe && !d.run && (d.missingSecrets ?? []).length === 0;
  };
  let next = rows.find((r) => ready(r) && (r.onboarding_state === "building" || r.onboarding_state === "rebuilding"));
  if (!next) {
    const stale = rows.find((r) => {
      const image = parseDetail(r.onboarding_detail).image;
      return ready(r) && r.onboarding_state === "ready" && image && imageOutdated(image, baseOf(base.image));
    });
    if (stale) {
      const reason = imageOutdated(parseDetail(stale.onboarding_detail).image!, baseOf(base.image))!;
      next = (await update(stale.repo, (_r, d) => ({ state: "rebuilding", detail: { ...d, rebuild: { reason, at: onboardingRuntime.now().toISOString() } } }))) ?? undefined;
    }
  }
  return next ? startBuild(next, base.image) : undefined;
}

/** Regressions name their own repos, so rows a test branch copied from a real database never take part. */
const onlyRepos = (only: readonly string[] | undefined) => (only ? inArray(repoSettings.repo, [...only]) : undefined);

/** Sandboxes the last reap found with no row pointing at them; a second sighting ends them. */
let suspects = new Set<string>();

async function reapOnboarding(rows: readonly RepoSettingsRow[]) {
  const machine = await thisMachine();
  const listed = await modal.api.list(config.factory.sandbox.appName, ONBOARDING_TAGS(machine.id));
  const owned = new Set(rows.map((r) => parseDetail(r.onboarding_detail).run?.sandboxId).filter(Boolean));
  const orphans = listed.map((s) => s.sandboxId).filter((id) => !owned.has(id));
  const ended = orphans.filter((id) => suspects.has(id));
  for (const id of ended) await terminateSandbox(id);
  suspects = new Set(orphans.filter((id) => !ended.includes(id)));
  return ended;
}

/**
 * Sets require_bugbot from each recipe PR still watched: true once Bugbot has a check run on it,
 * false once noCiGraceMinutes passed without one. A probe the row no longer holds writes nothing.
 */
async function probeBugbot(rows: readonly RepoSettingsRow[]) {
  const graceMs = config.factory.noCiGraceMinutes * 60_000;
  const results: unknown[] = [];
  for (const row of rows) {
    const probe = parseDetail(row.onboarding_detail).bugbotProbe;
    if (!probe) continue;
    try {
      const verdict = bugbotVerdict(await onboardingRuntime.bugbotRan(probe.pr), probe.since, onboardingRuntime.now().getTime(), graceMs);
      if (verdict === undefined) continue;
      const set = await db.transaction(async (tx) => {
        const [current] = await tx.select().from(repoSettings).where(eq(repoSettings.repo, row.repo)).for("update");
        const detail = parseDetail(current?.onboarding_detail);
        if (detail.bugbotProbe?.pr !== probe.pr || detail.bugbotProbe.since !== probe.since) return false;
        await tx.update(repoSettings).set({ require_bugbot: verdict, onboarding_detail: { ...detail, bugbotProbe: undefined } }).where(eq(repoSettings.repo, row.repo));
        return true;
      });
      if (!set) continue;
      log("onboarding:bugbot", { repo: row.repo, requireBugbot: verdict, pr: probe.pr });
      results.push({ repo: row.repo, requireBugbot: verdict });
    } catch (error) {
      results.push({ repo: row.repo, error: message(error) });
    }
  }
  return results;
}

const advancing = new Set<string>();
const REAP_EVERY_MS = 5 * 60_000;
let lastReap = 0;

/** The timer's onboarding pass: this machine's runs move on, then a build starts if one is due. */
export async function advanceOnboarding({ only }: { only?: readonly string[] } = {}) {
  const machine = await thisMachine();
  const rows = await db
    .select()
    .from(repoSettings)
    .where(
      and(
        sql`${repoSettings.onboarding_detail} ? 'run' or ${repoSettings.onboarding_detail} ? 'bugbotProbe' or ${repoSettings.onboarding_state} in ('building', 'rebuilding', 'ready')`,
        onlyRepos(only),
      ),
    );
  const results: unknown[] = await probeBugbot(rows);
  for (const row of rows) {
    const run = parseDetail(row.onboarding_detail).run;
    if (run && !hasSandbox(run)) {
      // This runner's own run waits for its intent's retry; another runner's is given up on.
      const mine = run.machine === machine.id;
      if (mine ? !leftBehind(row.repo, run, machine.id) : !overdue(run, LEASING_GIVE_UP_MS)) continue;
      const cleared = mine
        ? await clearLeasing(row.repo, run)
        : await clearLeasing(row.repo, run, "failed", "The onboarding run stopped before its sandbox was created; retry it.");
      if (cleared) {
        log("onboarding:leasing-abandoned", { repo: row.repo, slot: run.slot, machine: run.machine, retried: mine });
        results.push({ repo: row.repo, released: run.slot });
      }
      continue;
    }
    if (!run || run.machine !== machine.id || advancing.has(row.repo)) continue;
    advancing.add(row.repo);
    try {
      const outcome = run.kind === "agent" ? await advanceAgent(row, run) : await advanceBuild(row, run);
      if (outcome) results.push(outcome);
    } catch (error) {
      results.push({ repo: row.repo, error: message(error) });
    } finally {
      advancing.delete(row.repo);
    }
  }
  const started = await startBuilds({ only });
  const reapDue = (rows.length > 0 || suspects.size > 0) && Date.now() - lastReap >= REAP_EVERY_MS;
  const reaped = reapDue ? await reapOnboarding(await db.select().from(repoSettings)) : [];
  if (reapDue) lastReap = Date.now();
  return { ...(results.length > 0 && { advanced: results }), ...(started && { started }), ...(reaped.length > 0 && { reaped }) };
}
