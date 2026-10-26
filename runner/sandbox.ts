import { existsSync, readFileSync } from "node:fs";
import type { FactoryConfig, SandboxLimits } from "../lib/config";
import { installationTokens, type RepoName } from "../lib/github/app";
import type { JobHost } from "../lib/host";
import { modal, modalHost, rememberSandbox, sandboxName } from "../lib/modal-host";
import {
  CODEX_HOME,
  FACTORY_ROOT,
  GITHUB_TOKEN_PATH,
  INGEST_CONFIG_PATH,
  readSandboxImage,
  REPO_DIR,
  SANDBOX_HOME,
  slotAuthPath,
  T3_PORT,
  T3_USERDATA,
  type SandboxImage,
} from "../lib/sandbox";
import type { HarnessChoice } from "../lib/settings";
import { readHarnesses } from "../lib/t3-state";
import { json, reportServer, wiredRoots, withHooks, withServer, type Json } from "../lib/target-wiring";

// A job's Modal sandbox: what it is created with and how it is set up before its thread starts.

const CLAUDE = "claudeAgent";
const CODEX = "codex";

/** What a launch reads from this machine; regressions replace any of it. */
export const sandboxRuntime = {
  image: (): SandboxImage | null => readSandboxImage(),
  claudeToken: (): string | undefined => process.env.CLAUDE_CODE_OAUTH_TOKEN || undefined,
  githubToken: (repo: RepoName) => installationTokens.get(repo),
  /** The configured CODEX_HOME dirs that hold a login. */
  slots: (limits: Pick<SandboxLimits, "codexSlots">) => limits.codexSlots.filter((slot) => existsSync(slotAuthPath(slot))),
  slotAuth: (slot: string) => readFileSync(slotAuthPath(slot), "utf8"),
  driverOf: (provider: string) => {
    try {
      return readHarnesses().find((h) => h.id === provider)?.driver ?? provider;
    } catch {
      return provider;
    }
  },
  log: (event: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail })),
};

/**
 * The sandbox has one Claude Code and one Codex instance, so a harness maps by driver. A Claude
 * Code job on a runner without a Claude token, or one on any other driver, falls back to Codex.
 */
export function sandboxHarness(harness: HarnessChoice, driver: string, hasClaude: boolean, codexModel: string): { choice: HarnessChoice; fallback?: string } {
  if (driver === CODEX) return { choice: { provider: CODEX, model: harness.model } };
  if (driver === CLAUDE && hasClaude) return { choice: { provider: CLAUDE, model: harness.model } };
  const why = driver === CLAUDE ? "this runner has no CLAUDE_CODE_OAUTH_TOKEN" : `sandboxes have no ${driver} harness`;
  return { choice: { provider: CODEX, model: codexModel }, fallback: `${harness.provider} / ${harness.model} cannot run in a sandbox (${why}); launching on ${CODEX} / ${codexModel}` };
}

export const t3Settings = (choice: HarnessChoice, hasClaude: boolean) => ({
  defaultModelSelection: { instanceId: choice.provider, model: choice.model },
  textGenerationModelSelection: { instanceId: choice.provider, model: choice.model },
  defaultRuntimeMode: "full-access",
  providerInstances: {
    [CODEX]: { driver: CODEX, enabled: true, config: { binaryPath: "codex", homePath: CODEX_HOME } },
    [CLAUDE]: { driver: CLAUDE, enabled: hasClaude },
  },
});

/** Codex gets the factory-report server too, so a Codex-led run can call report_stage. */
export function codexConfig() {
  const { command, args } = reportServer(FACTORY_ROOT);
  return `[mcp_servers.factory-report]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`;
}

/** Just what the hooks read: where to report and the job's budget. */
export const ingestConfig = (config: Pick<FactoryConfig, "ingestUrl" | "secret">, budgetUsd: number) =>
  json({ ingestUrl: config.ingestUrl, secret: config.secret, factory: { budgetUsd } });

/** Secrets the sandbox's processes see as environment variables; never an API key that would bill per token. */
export const sandboxSecrets = (claudeToken: string | undefined): Record<string, string> =>
  claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {};

const sh = async (host: JobHost, script: string, timeoutMs = 60_000) => (await host.run("bash", ["-c", script], { timeoutMs })).stdout;

async function writeSecretFile(host: JobHost, path: string, text: string) {
  await host.writeFile(path, text);
  await host.run("chmod", ["600", path], { timeoutMs: 30_000 });
}

/**
 * The GitHub token the image's git credential helper and gh wrapper read. Rewriting it is all a
 * token refresh takes: nothing caches it, and it is never in the environment.
 */
export const writeGithubToken = (host: JobHost, token: string) => writeSecretFile(host, GITHUB_TOKEN_PATH, token);

export type SandboxSetup = {
  repo: string;
  choice: HarnessChoice;
  hasClaude: boolean;
  codexAuth: string;
  githubToken: string;
  ingest: string;
};

/**
 * Every step before the thread: logins, T3 and Codex settings, the clone, the wiring, a serving T3.
 * Files go through the host's file API, so no secret ever appears in a command line.
 */
export async function setupSandbox(host: JobHost, setup: SandboxSetup) {
  await host.run("mkdir", ["-p", CODEX_HOME, T3_USERDATA, "/work"], { timeoutMs: 30_000 });
  await host.run("chmod", ["700", CODEX_HOME], { timeoutMs: 30_000 });
  await writeSecretFile(host, `${CODEX_HOME}/auth.json`, setup.codexAuth);
  await host.writeFile(`${CODEX_HOME}/config.toml`, codexConfig());
  await host.writeFile(`${T3_USERDATA}/settings.json`, json(t3Settings(setup.choice, setup.hasClaude)));
  await writeSecretFile(host, INGEST_CONFIG_PATH, setup.ingest);
  await writeGithubToken(host, setup.githubToken);
  await host.run("git", ["clone", "--quiet", `https://github.com/${setup.repo}.git`, REPO_DIR], { timeoutMs: 300_000 });
  await wire(host);
  await startT3(host);
  await host.run(host.t3, ["project", "add", REPO_DIR, "--title", setup.repo.split("/").pop()!], { timeoutMs: 60_000 });
}

/**
 * T3 cuts each thread's worktree from origin/main, so the repo's committed wiring is what the
 * thread sees. Its factory paths are this runner's checkout; each one becomes a link to the
 * sandbox's copy. User-level wiring covers a repo that commits none.
 */
async function wire(host: JobHost) {
  const committed = wiredRoots(await host.readFile(`${REPO_DIR}/.claude/settings.json`), await host.readFile(`${REPO_DIR}/.mcp.json`));
  for (const root of committed.filter((r) => r !== FACTORY_ROOT)) {
    await host.run("mkdir", ["-p", root.slice(0, root.lastIndexOf("/")) || "/"], { timeoutMs: 30_000 });
    await host.run("ln", ["-sfn", FACTORY_ROOT, root], { timeoutMs: 30_000 });
  }
  const parse = (text: string | null): Json => (text ? (JSON.parse(text) as Json) : {});
  const userSettings = `${SANDBOX_HOME}/.claude/settings.json`;
  const userConfig = `${SANDBOX_HOME}/.claude.json`;
  await host.writeFile(userSettings, json(withHooks(parse(await host.readFile(userSettings)), FACTORY_ROOT)));
  await host.writeFile(userConfig, json({ ...withServer(parse(await host.readFile(userConfig)), FACTORY_ROOT), hasCompletedOnboarding: true }));
}

/** Started from an exec, `t3 serve` outlives it. Its log holds a pairing token, so it is never read back. */
async function startT3(host: JobHost) {
  await sh(host, `nohup ${host.t3} serve --host 127.0.0.1 --port ${T3_PORT} ${REPO_DIR} > /work/t3.log 2>&1 &`);
  for (let i = 0; i < 60; i++) {
    if (await host.exists(`${T3_USERDATA}/server-runtime.json`)) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("t3 serve did not become ready in the sandbox within 120 s");
}

/** Creates the job's sandbox; its id must be recorded on the job before anything else runs in it. */
export async function createJobSandbox({ key, attempt, label, image, limits, claudeToken }: {
  key: string;
  attempt: number;
  label: string;
  image: SandboxImage;
  limits: SandboxLimits;
  claudeToken: string | undefined;
}) {
  const sandbox = await modal.api.create({
    name: sandboxName(key, attempt),
    tags: { job: key, attempt: String(attempt), label },
    imageId: image.imageId,
    secrets: sandboxSecrets(claudeToken),
    // Claude Code refuses full access as root unless told it is in a sandbox.
    env: { IS_SANDBOX: "1" },
    limits,
  });
  rememberSandbox(sandbox);
  return { sandboxId: sandbox.sandboxId, host: modalHost(sandbox.sandboxId) };
}
