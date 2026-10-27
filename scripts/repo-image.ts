import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// Builds a repo's warm image by hand, the way a runner does, without touching the registry:
//   bun scripts/repo-image.ts owner/name [--recipe path] [--check "bun test"]... [--delete]
// The recipe comes from --recipe, else from the repo's main. With --check, a second sandbox starts
// from the new image, refreshes the checkout as a job launch does, and runs each check. --delete
// removes the image afterwards. Uses this Mac's Modal login, base image and GitHub App.

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { recipe: { type: "string" }, check: { type: "string", multiple: true }, delete: { type: "boolean" } },
});
const repo = positionals[0];
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error('Usage: bun scripts/repo-image.ts owner/name [--recipe path] [--check "bun test"] [--delete]');
  process.exit(2);
}

const { modal, modalHost, rememberSandbox, terminateSandbox, deleteSnapshot } = await import("../lib/modal-host");
const { parseRecipe, BUILD_EXIT, redact } = await import("../lib/recipe");
const { imageProblem, REPO_DIR } = await import("../lib/sandbox");
const { config } = await import("../runner/config");
const { sandboxRuntime, writeGithubToken } = await import("../runner/sandbox");
const { onboardingRuntime, startImageBuild, imageBuildStatus, finishImageBuild } = await import("../runner/onboarding");

const t0 = Date.now();
const log = (text: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);

const text = values.recipe ? readFileSync(values.recipe, "utf8") : await onboardingRuntime.committedRecipe(repo);
if (text === null) throw new Error(`${repo} has no recipe on main; pass --recipe`);
const parsed = parseRecipe(text);
if (!parsed.ok) throw new Error(parsed.error);
const recipe = parsed.recipe;
const limits = config.factory.sandbox;
const base = sandboxRuntime.image();
const problem = imageProblem(base, limits);
if (problem || !base) throw new Error(problem ?? "no base image");

const create = async (name: string, imageId: string) => {
  const sandbox = await modal.api.create({
    name: `${name}-${Date.now()}`.slice(0, 63),
    tags: { purpose: "repo-image-check" },
    imageId,
    secrets: {},
    env: { IS_SANDBOX: "1" },
    encryptedPorts: [],
    limits,
  });
  rememberSandbox(sandbox);
  return sandbox.sandboxId;
};

const sandboxes: string[] = [];
let imageId: string | undefined;
try {
  const builder = await create("repo-image-build", base.imageId);
  sandboxes.push(builder);
  log(`build sandbox ${builder} from base image built ${base.builtAt}`);
  const host = modalHost(builder);
  await startImageBuild(host, { repo, recipe, githubToken: await sandboxRuntime.githubToken(repo as `${string}/${string}`), checks: false });
  let status = await imageBuildStatus(host);
  while (!status.done) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    status = await imageBuildStatus(host);
  }
  if (status.code !== 0) throw new Error(`build failed: ${BUILD_EXIT[status.code] ?? `exit ${status.code}`}\n${redact(status.log)}`);
  log(`setup done:\n${redact(status.log, [], 12)}`);
  const finished = await finishImageBuild(host, builder, recipe, false);
  imageId = finished.imageId;
  log(`warm image ${imageId} at ${finished.commit.slice(0, 7)}, warmKey ${finished.warmKeyHash.slice(0, 12)}`);
  await terminateSandbox(builder);

  for (const check of values.check ?? []) {
    if (sandboxes.length === 1) {
      const warm = await create("repo-image-check", imageId);
      sandboxes.push(warm);
      const wh = modalHost(warm);
      log(`check sandbox ${warm} from the warm image`);
      await writeGithubToken(wh, await sandboxRuntime.githubToken(repo as `${string}/${string}`));
      await wh.run("git", ["-C", REPO_DIR, "fetch", "--quiet", "origin", "--prune"], { timeoutMs: 120_000 });
      await wh.run("git", ["-C", REPO_DIR, "checkout", "--quiet", "-B", "main", "origin/main"], { timeoutMs: 60_000 });
      for (const command of recipe.setup) {
        const started = Date.now();
        await wh.run("bash", ["-c", command], { cwd: REPO_DIR, timeoutMs: 180_000 });
        log(`setup again: ${command} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
    }
    const started = Date.now();
    const out = await modalHost(sandboxes[1]!).run("bash", ["-c", check], { cwd: REPO_DIR, timeoutMs: 600_000 });
    log(`check passed: ${check} in ${((Date.now() - started) / 1000).toFixed(1)}s\n${redact(`${out.stdout}\n${out.stderr}`, [], 8)}`);
  }
} finally {
  for (const id of sandboxes) await terminateSandbox(id).catch((error: unknown) => log(`could not terminate ${id}: ${String(error)}`));
  if (imageId && values.delete) {
    await deleteSnapshot(imageId);
    log(`deleted ${imageId}`);
  }
}
process.exit(0);
