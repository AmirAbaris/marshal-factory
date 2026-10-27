import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ModalClient, type Sandbox } from "modal";
import { z } from "zod";
import { loadLimits, SANDBOX_IMAGE_PATH } from "../lib/config";
import { imageDrift, rebuildText, type ImageVersions } from "../lib/machine";
import {
  enabledPstack,
  FACTORY_ROOT,
  GITHUB_TOKEN_PATH,
  parseVersion,
  pinnedVersions,
  PSTACK_DIR,
  PSTACK_PLUGIN,
  pstackVersion,
  type SandboxImage,
} from "../lib/sandbox";

// Builds the image factory sandboxes launch from, and records its id for the runner.
//   bun scripts/sandbox-image.ts
// The base layers come from Dockerfile commands and Modal caches them. The factory's hook and MCP
// entry points are bundled here with Bun, one self-contained file each at the path the wiring
// names, so the sandbox needs no checkout and no install. A sandbox from the base gets those files,
// and its filesystem snapshot, kept indefinitely, is the image. T3, Claude Code, Codex and PStack
// install at the versions factory.sandbox pins, and the build fails unless the sandbox reports
// exactly those. Rerun it after the hooks or a pin change.

const root = join(import.meta.dirname, "..");
const ENTRIES = ["hooks/report.ts", "hooks/budget.ts", "mcp/factory-report.ts"];
const limits = loadLimits().sandbox;

const b64 = (text: string) => Buffer.from(text).toString("base64");
const install = (path: string, text: string) => `RUN echo ${b64(text)} | base64 -d > ${path} && chmod 755 ${path}`;

// The job's GitHub token lives in one file, so a refresh is a rewrite; git and gh both read it per call.
const credentialHelper = `#!/bin/sh
test "$1" = get || exit 0
echo username=x-access-token
echo "password=$(cat ${GITHUB_TOKEN_PATH})"
`;
const ghWrapper = `#!/bin/sh
GH_TOKEN="$(cat ${GITHUB_TOKEN_PATH} 2>/dev/null)" exec /usr/bin/gh "$@"
`;

const t0 = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`);

async function sh(sandbox: Sandbox, script: string, timeoutMs = 120_000) {
  const proc = await sandbox.exec(["bash", "-c", script], { timeoutMs });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) throw new Error(`${script} exited ${code}: ${err.trim().slice(-500)}`);
  return out.trim();
}

const codexPluginsSchema = z.object({ installed: z.array(z.object({ pluginId: z.string(), version: z.string(), enabled: z.boolean() })) });

/**
 * PStack as both CLIs see it: enabled for claude and codex, from the pinned checkout, with its
 * skills on disk. Its version string when all of that holds, else undefined.
 */
async function pstackInImage(sandbox: Sandbox) {
  const plugin = enabledPstack(await sh(sandbox, "claude plugin list --json"));
  const commit = await sh(sandbox, `git -C ${PSTACK_DIR} rev-parse HEAD`);
  const codex = codexPluginsSchema.parse(JSON.parse(await sh(sandbox, "codex plugin list --json"))).installed.find((p) => p.pluginId === PSTACK_PLUGIN);
  if (!plugin?.version || !plugin.installPath || !codex?.enabled || codex.version !== plugin.version) return undefined;
  const skills = Number(await sh(sandbox, `ls ${plugin.installPath}/skills | wc -l`));
  log(`PStack ${plugin.version} at ${commit.slice(0, 12)}: ${skills} skills in ${plugin.installPath}, enabled for codex too`);
  return skills > 0 ? pstackVersion({ ...limits.pstack, version: plugin.version, commit }) : undefined;
}

const bundleDir = mkdtempSync(join(tmpdir(), "factory-bundle-"));
const modal = new ModalClient();
let sandbox: Sandbox | undefined;
try {
  execFileSync("bun", ["build", ...ENTRIES, "--target=bun", "--root", ".", "--outdir", bundleDir, "--entry-naming", "[dir]/[name].ts"], { cwd: root, stdio: "ignore" });
  log(`bundled ${ENTRIES.join(", ")}`);

  const app = await modal.apps.fromName(limits.appName, { createIfMissing: true });
  const base = modal.images.fromRegistry("node:22-bookworm").dockerfileCommands([
    "RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates procps unzip && rm -rf /var/lib/apt/lists/*",
    "RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg" +
      ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list' +
      " && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*",
    "RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
    `RUN curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${limits.t3Version} T3CODE_INSTALL_BIN_DIR=/usr/local/bin sh`,
    `RUN npm i -g @anthropic-ai/claude-code@${limits.claudeCodeVersion} @openai/codex@${limits.codexVersion}`,
    // Neither CLI pins a marketplace to a commit, so each adds the checkout as a local marketplace.
    `RUN git init -q ${PSTACK_DIR} && git -C ${PSTACK_DIR} fetch -q --depth 1 https://github.com/${limits.pstack.repo}.git ${limits.pstack.commit}` +
      ` && git -C ${PSTACK_DIR} checkout -q FETCH_HEAD` +
      ` && claude plugin marketplace add ${PSTACK_DIR} && claude plugin install ${PSTACK_PLUGIN}` +
      ` && codex plugin marketplace add ${PSTACK_DIR} && codex plugin add ${PSTACK_PLUGIN}`,
    install("/usr/local/bin/git-credential-factory", credentialHelper),
    install("/usr/local/bin/gh", ghWrapper),
    "RUN git config --global user.name marshal-factory && git config --global user.email marshal-factory@users.noreply.github.com" +
      " && git config --global credential.https://github.com.helper factory && git config --global init.defaultBranch main",
  ]);
  log("building the base image (the first build takes a few minutes)");
  sandbox = await modal.sandboxes.create(app, base, {
    name: `image-build-${Date.now()}`,
    tags: { purpose: "image-build" },
    runtime: "gvisor",
    timeoutMs: 20 * 60_000,
    command: ["sleep", "infinity"],
  });
  log(`build sandbox ${sandbox.sandboxId} up`);
  for (const entry of ENTRIES) await sandbox.filesystem.writeText(readFileSync(join(bundleDir, entry), "utf8"), join(FACTORY_ROOT, entry));
  const pinned = pinnedVersions(limits);
  const built: ImageVersions = {
    t3: parseVersion("t3", await sh(sandbox, "t3 --version")) ?? undefined,
    claudeCode: parseVersion("claudeCode", await sh(sandbox, "claude --version")) ?? undefined,
    codex: parseVersion("codex", await sh(sandbox, "codex --version")) ?? undefined,
    pstack: await pstackInImage(sandbox),
  };
  const drift = imageDrift(built, pinned);
  if (drift.length > 0) throw new Error(`the build sandbox does not match the pins: ${rebuildText(drift)}`);
  log(`versions: ${Object.entries(built).map(([component, version]) => `${component} ${version}`).join(" | ")} | bun ${await sh(sandbox, "bun --version")}`);
  await sh(sandbox, `cd /tmp && echo '{}' | bun ${FACTORY_ROOT}/hooks/report.ts && echo '{}' | bun ${FACTORY_ROOT}/hooks/budget.ts`);
  log("hook bundles run");

  const image = await sandbox.snapshotFilesystem({ ttlMs: null, timeoutMs: 300_000 });
  const factoryCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const state: SandboxImage = { imageId: image.imageId, t3Version: limits.t3Version, versions: pinned, factoryCommit, builtAt: new Date().toISOString() };
  mkdirSync(dirname(SANDBOX_IMAGE_PATH), { recursive: true });
  writeFileSync(SANDBOX_IMAGE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  chmodSync(SANDBOX_IMAGE_PATH, 0o600);
  log(`image ${image.imageId} recorded in ${SANDBOX_IMAGE_PATH}`);
} finally {
  await sandbox?.terminate().catch((error: unknown) => log(`could not terminate the build sandbox: ${String(error)}`));
  rmSync(bundleDir, { recursive: true, force: true });
  modal.close();
}
