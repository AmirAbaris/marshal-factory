import "./test-guard";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxImage } from "../lib/sandbox";
import { fake, FakeSandbox, type Reply } from "./fake-modal";

const { factorySchema } = await import("../lib/config");
const { sandboxReadinessSchema } = await import("../lib/machine");
const { pinnedVersions, PSTACK_PLUGIN, readSandboxImage } = await import("../lib/sandbox");
const { buildLockPath, buildSandboxImage, BuildLockedError } = await import("../lib/sandbox-image-build");
const { baseImageBuild, baseImageIdle, baseImageRuntime, rebuildBaseImage, resetBaseImage, RETRY_AFTER_MS } = await import("../runner/base-image");

const limits = factorySchema.parse({}).sandbox;
const pinned = pinnedVersions(limits);
const dir = mkdtempSync(join(tmpdir(), "base-image-"));
const quiet = () => {};

const oldImage: SandboxImage = {
  imageId: "im-old",
  t3Version: limits.t3Version,
  versions: { ...pinned, claudeCode: "2.1.309" },
  factoryCommit: "abc1234",
  builtAt: "2026-10-28T10:00:00.000Z",
};
const storeOld = (path: string) => writeFileSync(path, `${JSON.stringify(oldImage, null, 2)}\n`);

/** A build sandbox that reports these versions and runs the hook bundles unless told not to. */
function buildBox(overrides: { claudeCode?: string; verifyExit?: number } = {}) {
  const box = new FakeSandbox(`sb-build-${++fake.created}`);
  fake.answer = (_sandbox, argv): Reply => {
    const script = argv[2] ?? "";
    if (script === "t3 --version") return { stdout: `t3 v${limits.t3Version}` };
    if (script === "claude --version") return { stdout: `${overrides.claudeCode ?? limits.claudeCodeVersion} (Claude Code)` };
    if (script === "codex --version") return { stdout: `codex-cli ${limits.codexVersion}` };
    if (script === "playwright-mcp --version") return { stdout: `Version ${limits.playwrightMcpVersion}` };
    if (script === "claude plugin list --json") return { stdout: JSON.stringify([{ id: PSTACK_PLUGIN, version: limits.pstack.version, enabled: true, installPath: "/root/pstack" }]) };
    if (script.startsWith("git -C /opt/pstack rev-parse")) return { stdout: limits.pstack.commit };
    if (script === "codex plugin list --json") return { stdout: JSON.stringify({ installed: [{ pluginId: PSTACK_PLUGIN, version: limits.pstack.version, enabled: true }] }) };
    if (script.startsWith("ls /root/pstack/skills")) return { stdout: "40" };
    if (script === "bun --version") return { stdout: "1.3.1" };
    if (script.includes("factory-verify")) return { code: overrides.verifyExit ?? 0 };
    return {};
  };
  return box;
}

// The build: the new id is written only after the pins read back and the hook bundles run.
{
  const path = join(dir, "pass.json");
  storeOld(path);
  const box = buildBox();
  const built = await buildSandboxImage({ limits, log: quiet, open: async () => box, path });
  assert.deepEqual(readSandboxImage(path), built, "a build that passes its checks is recorded");
  assert.equal(built.imageId, fake.snapshots.at(-1)!.imageId);
  assert.deepEqual(built.versions, pinned, "with the versions it was checked against");
  assert.equal(fake.snapshots.at(-1)!.ttlMs, null, "and a snapshot Modal keeps");
  assert.ok(box.files.has("/opt/marshal-factory/hooks/verify.ts") && box.files.has("/opt/marshal-factory/playbooks/factory.md"), "the bundles and playbooks went in");
  assert.equal(box.terminated, true);
  assert.equal(existsSync(buildLockPath(path)), false, "the lock goes with the build");
}
for (const [what, overrides, error] of [
  ["a sandbox that reports another Claude Code", { claudeCode: "2.1.309" }, /does not match the pins: Rebuild the sandbox image: Claude Code 2.1.309 →/],
  ["hook bundles that do not run", { verifyExit: 1 }, /factory-verify/],
] as const) {
  const path = join(dir, "fail.json");
  storeOld(path);
  const before = readFileSync(path, "utf8");
  const snapshots = fake.snapshots.length;
  const box = buildBox(overrides);
  await assert.rejects(buildSandboxImage({ limits, log: quiet, open: async () => box, path }), error);
  assert.equal(readFileSync(path, "utf8"), before, `${what} leaves the old image recorded`);
  assert.equal(fake.snapshots.length, snapshots, `${what} is never snapshotted`);
  assert.equal(box.terminated, true, `${what} still ends its sandbox`);
  assert.equal(existsSync(buildLockPath(path)), false);
}
{
  const path = join(dir, "locked.json");
  storeOld(path);
  writeFileSync(buildLockPath(path), String(process.pid));
  let opened = false;
  await assert.rejects(
    buildSandboxImage({ limits, log: quiet, open: async () => ((opened = true), buildBox()), path }),
    (error: unknown) => error instanceof BuildLockedError && error.pid === process.pid,
    "a live build's lock keeps a second one out",
  );
  assert.equal(opened, false, "before any sandbox starts");
  writeFileSync(buildLockPath(path), "999999");
  await buildSandboxImage({ limits, log: quiet, open: async () => buildBox(), path });
  assert.notEqual(readSandboxImage(path)!.imageId, "im-old", "a dead process's lock is taken over");
}

// The runner: drift starts one build from the tick, which returns at once.
const events: { event: string; detail: Record<string, unknown> }[] = [];
baseImageRuntime.log = (event, detail) => void events.push({ event, detail });
baseImageRuntime.modalToken = () => true;
baseImageRuntime.limits = () => limits;
let clock = Date.parse("2026-10-29T18:00:00.000Z");
baseImageRuntime.now = () => clock;
const calls = { changed: 0, landed: 0 };
const hooks = { changed: () => void calls.changed++, landed: () => void calls.landed++ };

{
  const path = join(dir, "runner.json");
  storeOld(path);
  baseImageRuntime.image = () => readSandboxImage(path);
  let builds = 0;
  let finish: (image: SandboxImage) => void = () => {};
  baseImageRuntime.build = () => {
    builds++;
    return new Promise((resolve) => (finish = resolve));
  };
  const started = rebuildBaseImage(hooks);
  assert.deepEqual(started, { started: `Rebuild the sandbox image: Claude Code 2.1.309 → ${limits.claudeCodeVersion}` }, "a drifted pin starts a rebuild");
  assert.deepEqual(baseImageBuild(), { state: "building", reason: started!.started, startedAt: new Date(clock).toISOString() });
  assert.deepEqual(rebuildBaseImage(hooks), { building: started!.started }, "the next tick finds it in flight");
  assert.equal(builds, 1, "one build at a time");
  assert.equal(events.at(-1)!.event, "sandbox-image:started");
  sandboxReadinessSchema.parse({ modal: true, claude: true, codexSlots: 1, image: true, imageBuild: baseImageBuild() });

  const fresh = { ...oldImage, imageId: "im-new", versions: pinned };
  writeFileSync(path, JSON.stringify(fresh));
  finish(fresh);
  await baseImageIdle();
  assert.equal(calls.landed, 1, "queued jobs launch once it lands");
  assert.equal(calls.changed, 2, "the panel hears of the start and the end");
  assert.equal(baseImageBuild(), undefined);
  assert.equal(events.at(-1)!.event, "sandbox-image:landed");
  assert.equal(rebuildBaseImage(hooks), undefined, "an image that matches the pins builds nothing");
  assert.equal(builds, 1);
}

// A failed build leaves the old image in place and is retried after RETRY_AFTER_MS, or at once for other pins.
resetBaseImage();
{
  const path = join(dir, "runner-fail.json");
  storeOld(path);
  baseImageRuntime.image = () => readSandboxImage(path);
  let builds = 0;
  let verifies = true;
  baseImageRuntime.build = (pins, log) => {
    builds++;
    return buildSandboxImage({ limits: pins, log, open: async () => buildBox(verifies ? {} : { claudeCode: "2.1.309" }), path });
  };
  verifies = false;
  assert.ok("started" in rebuildBaseImage(hooks)!);
  await baseImageIdle();
  assert.equal(readSandboxImage(path)!.imageId, "im-old", "the old image stays recorded");
  const failed = baseImageBuild();
  assert.equal(failed?.state, "failed");
  assert.match(failed!.state === "failed" ? failed!.error : "", /does not match the pins/, "the panel shows why");
  assert.equal(events.at(-1)!.event, "sandbox-image:failed");
  assert.ok("failed" in rebuildBaseImage(hooks)!, "the next tick does not build the same pins again");
  assert.equal(builds, 1);
  clock += RETRY_AFTER_MS;
  verifies = true;
  assert.ok("started" in rebuildBaseImage(hooks)!, "an hour later it tries again");
  await baseImageIdle();
  assert.equal(readSandboxImage(path)!.versions?.claudeCode, limits.claudeCodeVersion, "and the new image lands");
  assert.equal(baseImageBuild(), undefined, "clearing the failure");
  assert.equal(builds, 2);

  resetBaseImage();
  storeOld(path);
  verifies = false;
  rebuildBaseImage(hooks);
  await baseImageIdle();
  baseImageRuntime.limits = () => ({ ...limits, codexVersion: "0.165.0" });
  assert.ok("started" in rebuildBaseImage(hooks)!, "a changed pin is built at once, even after a failure");
  await baseImageIdle();
  baseImageRuntime.limits = () => limits;
}

// A build by hand holds the lock: the runner records no failure and looks again next tick.
resetBaseImage();
{
  const path = join(dir, "runner-locked.json");
  storeOld(path);
  baseImageRuntime.image = () => readSandboxImage(path);
  writeFileSync(buildLockPath(path), String(process.pid));
  baseImageRuntime.build = (pins, log) => buildSandboxImage({ limits: pins, log, open: async () => buildBox(), path });
  rebuildBaseImage(hooks);
  await baseImageIdle();
  assert.equal(baseImageBuild(), undefined);
  assert.equal(events.at(-1)!.event, "sandbox-image:locked");
  rmSync(buildLockPath(path));
  assert.ok("started" in rebuildBaseImage(hooks)!, "the next tick tries again");
  await baseImageIdle();
}

// No stored image, or no Modal token: nothing is built.
resetBaseImage();
let built = false;
baseImageRuntime.build = async () => ((built = true), oldImage);
baseImageRuntime.image = () => null;
assert.equal(rebuildBaseImage(hooks), undefined, "a first build stays a manual step");
baseImageRuntime.image = () => oldImage;
baseImageRuntime.modalToken = () => false;
assert.equal(rebuildBaseImage(hooks), undefined, "a runner without a Modal token cannot build");
assert.equal(built, false);

console.log("base image regressions passed");
