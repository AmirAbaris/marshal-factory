import "./test-guard";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import type { OnboardingDetail } from "../lib/onboarding";
import { fake, fakeModal, sandboxes, type FakeSandbox } from "./fake-modal";

const { db } = await import("../db/client");
const { codexSlotLeases, intents, jobs, repoSettings } = await import("../db/schema");
type RepoRow = typeof repoSettings.$inferSelect;
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { modal } = await import("../lib/modal-host");
const recipes = await import("../lib/recipe");
const { recipeHash } = await import("../lib/recipe-hash");
const onboarding = await import("../lib/onboarding");
const actions = await import("../lib/repo-onboarding");
const { pinnedVersions, REPO_DIR, GITHUB_TOKEN_PATH } = await import("../lib/sandbox");
const { githubPushIntent } = await import("../lib/webhooks");
const { config } = await import("../runner/ops");
const { threads } = await import("../runner/threads");
const { sandboxRuntime } = await import("../runner/sandbox");
const { launchInSandboxes, sandboxStart } = await import("../runner/launch");
const runner = await import("../runner/onboarding");
const { ORPHAN_LEASE_MS, releaseOrphanLeases } = await import("../runner/lifecycle");

modal.api = fakeModal;

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
const owner = { email: OWNER, emailVerified: true };
const stamp = Date.now();
const NS = `test-onb-${stamp}`;
// The test branch copies a real database, whose repos must never take this machine's build slot.
const ours = async () => (await db.select({ repo: repoSettings.repo }).from(repoSettings).where(like(repoSettings.repo, `${NS}/%`))).map((r) => r.repo);
const { parseRecipe, buildScript, warmKeyTouched, BUILD_FILES } = recipes;

// The recipe schema.
const valid = { system: ["libvips-dev"], runtimes: { node: "22", bun: "1.4.4" }, setup: ["bun install --frozen-lockfile"], checks: { test: "bun test", lint: "bun run lint" } };
const parsed = parseRecipe(JSON.stringify(valid));
assert.ok(parsed.ok, "a plain recipe parses");
assert.deepEqual(parseRecipe("{"), { ok: false, error: ".factory/setup.json is not valid JSON." });
assert.match((parseRecipe(JSON.stringify({ ...valid, services: ["postgres"] })) as { error: string }).error, /services, which the factory does not run yet/, "services are refused by name");
assert.equal(parseRecipe(JSON.stringify({ ...valid, system: ["libvips-dev; rm -rf /"] })).ok, false, "an apt name that is not one is refused");
assert.equal(parseRecipe(JSON.stringify({ ...valid, runtimes: { node: "latest" } })).ok, false, "a runtime pin is a version");
assert.equal(parseRecipe(JSON.stringify({ ...valid, checks: { e2e: "x" } })).ok, false, "only the four checks");
assert.equal(parseRecipe(JSON.stringify({ ...valid, env: [{ name: "BAD-NAME", purpose: "", required: true }] })).ok, false, "env names are identifiers");
assert.equal(parseRecipe(JSON.stringify({ checks: {} })).ok, false, "setup is required");
const recipe = parsed.ok ? parsed.recipe : assert.fail();
assert.equal(recipeHash(recipe), recipeHash(JSON.parse(JSON.stringify({ checks: valid.checks, setup: valid.setup, runtimes: { bun: "1.4.4", node: "22" }, system: valid.system }))), "key order does not change the hash");
assert.notEqual(recipeHash(recipe), recipeHash({ ...recipe, setup: ["bun install"] }));
assert.equal(warmKeyTouched(recipe, ["src/a.ts"]), false);
assert.equal(warmKeyTouched(recipe, ["apps/web/bun.lock"]), true, "the default warmKey covers lockfiles in any directory");
assert.equal(warmKeyTouched(recipe, [".factory/setup.json"]), true, "the recipe itself always counts");
assert.equal(warmKeyTouched({ ...recipe, warmKey: ["deps/**"] }, ["bun.lock"]), false, "a recipe's own warmKey replaces the defaults");
assert.equal(warmKeyTouched({ ...recipe, warmKey: ["deps/**"] }, ["deps/x.txt"]), true);
const script = buildScript(recipe, "/work/repo", { checks: true });
assert.match(script, /apt-get install -y --no-install-recommends libvips-dev \|\| exit 10/);
assert.match(script, new RegExp(`echo ${Buffer.from("bun install --frozen-lockfile").toString("base64")} \\| base64 -d\\)" \\|\\| exit 20`), "setup commands travel base64 encoded and stop the build");
assert.match(script, /printf '%s\\t%s\\n' test \$\? >> \/work\/onboarding\/checks.tsv/, "checks record their exit codes");
assert.doesNotMatch(buildScript(recipe, "/work/repo", { checks: false }), /checks.tsv/, "a plain build runs no checks");
assert.deepEqual(recipes.parseCheckResults("test\t0\nlint\t1\nbogus\t0\n", recipe), [
  { name: "test", command: "bun test", ok: true },
  { name: "lint", command: "bun run lint", ok: false, note: "exited 1" },
]);
// A Python pin installs that version and fails the build when python3 is still another one. Fakes stand in for every installer.
const pyBin = mkdtempSync(join(tmpdir(), "onb-python-"));
const fakeTool = (name: string, body: string) => writeFileSync(join(pyBin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
fakeTool("python3", `cat ${pyBin}/version`);
fakeTool("uv", `echo "uv $*" >> ${pyBin}/calls; if [ "$1 $2" = "python find" ]; then echo /opt/uv-python/cpython/bin/python3; fi`);
fakeTool("apt-get", `echo "apt-get $*" >> ${pyBin}/calls`);
fakeTool("ln", `echo "ln $*" >> ${pyBin}/calls`);
const buildWithPython = (installed: string) => {
  writeFileSync(join(pyBin, "version"), `Python ${installed}\n`);
  writeFileSync(join(pyBin, "calls"), "");
  const result = spawnSync("bash", ["-c", buildScript({ runtimes: { python: "3.12" }, setup: ["true"], checks: {} }, pyBin, { checks: false })], {
    env: { ...process.env, PATH: `${pyBin}:/usr/bin:/bin` },
    encoding: "utf8",
  });
  return { code: result.status, calls: readFileSync(join(pyBin, "calls"), "utf8"), out: result.stdout };
};
const pinned = buildWithPython("3.12.4");
assert.deepEqual([pinned.code, pinned.calls], [0, ""], "the pinned Python already there installs nothing");
const stale = buildWithPython("3.11.2");
assert.match(stale.calls, /^uv python install 3\.12$/m, "another Python installs the pin with uv");
assert.match(stale.calls, /^ln -sf \/opt\/uv-python\/cpython\/bin\/python3 \/usr\/local\/bin\/python3$/m, "and puts it first on PATH");
assert.doesNotMatch(stale.calls, /apt-get/, "not Debian's python3");
assert.equal(stale.code, 13, "a build whose python3 is still not the pin fails");
assert.match(stale.out, /python3 is Python 3\.11\.2, not the pinned 3\.12/);
assert.equal(buildWithPython("3.120.1").code, 13, "3.120 is not 3.12");
assert.equal(recipes.BUILD_EXIT[13], "installing the pinned Python failed");
const leaky = "DATABASE_URL=postgres://u:hunter2@h/db\nAuthorization: Bearer abcdefghijklmnop\nghp_abcdefghijklmnopqrstuvwxyz0123\nok line";
const redacted = recipes.redact(leaky, ["DATABASE_URL"]);
assert.ok(!/hunter2|abcdefghijklmnop|ghp_/.test(redacted), redacted);
assert.match(redacted, /ok line/);

// Names and image choice.
assert.equal(onboarding.modalSecretName("Ski043/Factory.Demo"), "mf-repo-ski043-factory-demo");
assert.ok(onboarding.modalSecretName(`a/${"x".repeat(100)}`).length <= 64);
const pins = config.factory.sandbox;
const baseImage = { imageId: "im-base", t3Version: pins.t3Version, versions: pinnedVersions(pins), factoryCommit: "abc", builtAt: "2026-10-27T10:00:00.000Z" };
const base = { versions: pinnedVersions(pins), builtAt: baseImage.builtAt };
const warmImage = { id: "im-warm-1", builtAt: "2026-10-27T11:00:00.000Z", commit: "c0ffee0", base, recipeHash: recipeHash(recipe), warmKeyHash: "w" };
const repoRow = (repo: string, state: RepoRow["onboarding_state"], detail: OnboardingDetail = {}): RepoRow => ({
  repo,
  display_name: null,
  is_default: false,
  enabled: true,
  provider: null,
  execution: null,
  autonomy: "off",
  protected_paths: null,
  max_changed_lines: null,
  onboarding_state: state,
  onboarding_detail: detail,
  onboarding_started_at: null,
  onboarding_at: null,
  updated_at: new Date(),
  updated_by: "test",
});
assert.deepEqual(onboarding.repoImage(repoRow("a/legacy", null), base), { kind: "base" }, "a repo from before onboarding launches from the base image");
assert.deepEqual(onboarding.repoImage(repoRow("a/b", "ready", { image: warmImage }), base), { kind: "warm", imageId: "im-warm-1" });
assert.deepEqual(onboarding.repoImage(repoRow("a/b", "rebuilding", { image: warmImage }), base), { kind: "warm", imageId: "im-warm-1" }, "the old image serves while a new one builds");
assert.deepEqual(onboarding.repoImage(repoRow("a/b", "failed", { image: warmImage }), base), { kind: "warm", imageId: "im-warm-1" }, "and after a rebuild failed");
const repinned = { ...base, versions: { ...base.versions, codex: "9.9.9" } };
assert.match((onboarding.repoImage(repoRow("a/b", "ready", { image: warmImage }), repinned) as { outdated: string }).outdated, /Codex .+ → 9\.9\.9/, "a base pin change makes it outdated");
assert.equal(onboarding.repoImage(repoRow("a/b", "ready", { image: warmImage }), { ...base, builtAt: "later" }).kind, "base", "so does a rebuilt base image");
assert.deepEqual(onboarding.repoImage(repoRow("a/b", "analyzing"), base), { kind: "blocked", reason: "a/b is not onboarded yet (analyzing)" });
assert.equal(onboarding.repoImage(repoRow("a/b", "needs_input"), base).kind, "blocked");
const start = sandboxStart(repoRow("a/b", "ready", { image: warmImage, recipe, secretsSet: ["API_KEY"] }), baseImage);
assert.deepEqual(start, { imageId: "im-warm-1", warm: { setup: recipe.setup }, namedSecrets: ["mf-repo-a-b"] }, "a warm launch has the repo set up and its secret attached");
assert.deepEqual(sandboxStart(repoRow("a/b", "ready", { image: warmImage }), { ...baseImage, builtAt: "later" }), { imageId: "im-base", namedSecrets: [], outdated: "the base image was rebuilt since" });
assert.deepEqual(onboarding.afterRecipe({ ...recipe, env: [{ name: "K", purpose: "p", required: true }] }, {}), { state: "needs_input", missingSecrets: ["K"] });
assert.deepEqual(onboarding.afterRecipe({ ...recipe, env: [{ name: "K", purpose: "p", required: false }] }, {}), { state: "building", missingSecrets: [] }, "an optional env var never blocks");
assert.deepEqual(onboarding.afterRecipe(recipe, { image: warmImage }), { state: "rebuilding", missingSecrets: [] });

// The push webhook names the repo and what changed.
const push = githubPushIntent("push", {
  ref: "refs/heads/main",
  after: "abc",
  repository: { default_branch: "main", full_name: "o/r" },
  commits: [{ added: ["a"], modified: ["bun.lock"], removed: [] }, { modified: ["bun.lock", ".factory/setup.json"] }],
});
assert.deepEqual(push && { ...push, detail: JSON.parse(push.detail!) }, { kind: "repo_push", key: "repo-push:o/r:abc", detail: { repo: "o/r", after: "abc", files: ["a", "bun.lock", ".factory/setup.json"] } });
assert.equal(githubPushIntent("push", { ref: "refs/heads/feature", repository: { default_branch: "main", full_name: "o/r" } }), null);
const pushFlags = (body: Record<string, unknown>) => {
  const intent = githubPushIntent("push", { ref: "refs/heads/main", after: "def", repository: { default_branch: "main", full_name: "o/r" }, ...body });
  return Boolean(JSON.parse(intent!.detail!).truncated);
};
const srcCommits = (n: number) => Array.from({ length: n }, (_, i) => ({ modified: [`src/${i}.ts`] }));
assert.equal(pushFlags({ commits: srcCommits(19) }), false, "a push GitHub lists in full names its files");
assert.equal(pushFlags({ commits: srcCommits(20) }), true, "a push with as many commits as GitHub lists may hide a lockfile, so it counts as touching everything");
assert.equal(pushFlags({ commits: srcCommits(3), size: 40 }), true, "so does one whose size says commits were left out");
assert.equal(pushFlags({ commits: srcCommits(3), distinct_size: 25 }), true);
assert.equal(pushFlags({ commits: srcCommits(1), forced: true }), true, "and a forced push, whose commits say nothing of what it rewound");

// Runner wiring, as the sandbox regressions do it.
const events: { event: string; detail: Record<string, unknown> }[] = [];
const slotA = `/tmp/onb-slot-a-${stamp}`;
const slotB = `/tmp/onb-slot-b-${stamp}`;
Object.assign(sandboxRuntime, {
  image: () => baseImage,
  claudeToken: () => undefined,
  modalToken: () => true,
  githubToken: async () => "ghs_fake_installation_token",
  slots: () => [slotA],
  slotAuth: (s: string) => `{"slot":"${s}"}`,
  driverOf: (provider: string) => provider,
  log: (event: string, detail: Record<string, unknown>) => void events.push({ event, detail }),
  slotHealthPath: join(mkdtempSync(join(tmpdir(), "onb-slot-health-")), "codex-slots.json"),
});
const committed: Record<string, string | null> = {};
runner.onboardingRuntime.committedRecipe = async (repo) => committed[repo] ?? null;
let threadState: "running" | "stopped" = "running";
threads.read = async () => ({ state: threadState, status: null, lastMessage: "I wrote the recipe." });
fake.answer = (sandbox, argv) => {
  const line = argv.join(" ");
  if (argv[0] === "rm") {
    for (const path of argv.slice(2)) for (const file of [...sandbox.files.keys()]) if (file === path || file.startsWith(`${path}/`)) sandbox.files.delete(file);
    return {};
  }
  if (line.startsWith("t3 thread start")) return { stdout: '{"threadId":"thread-onb"}' };
  if (line === `git -C ${REPO_DIR} rev-parse HEAD`) return { stdout: "abc1234def\n" };
  if (line === `git -C ${REPO_DIR} ls-files`) return { stdout: "bun.lock\npackage.json\nsrc/a.ts\n" };
  if (argv[0] === "sha256sum") return { stdout: argv.slice(2).map((f) => `aa  ${f}`).join("\n") };
  if (line === "claude plugin list --json") return { stdout: "[]" };
  return {};
};
const row = async (repo: string) => (await db.select().from(repoSettings).where(eq(repoSettings.repo, repo)))[0]!;
const detail = async (repo: string) => onboarding.parseDetail((await row(repo)).onboarding_detail);
const sandboxOf = (id: string | undefined) => sandboxes.get(id!) as FakeSandbox;
const insert = (repo: string, state: RepoRow["onboarding_state"], d: OnboardingDetail = {}) =>
  db.insert(repoSettings).values({ repo, enabled: true, onboarding_state: state, onboarding_detail: d, onboarding_at: new Date(), updated_at: new Date(), updated_by: "test" });
const finishBuild = (repo: string, code: number, log = "") =>
  detail(repo).then((d) => {
    const box = sandboxOf(d.run?.sandboxId);
    box.files.set(BUILD_FILES.log, log);
    box.files.set(BUILD_FILES.checks, "test\t0\nlint\t1\n");
    box.files.set(BUILD_FILES.code, `${code}\n`);
    return box;
  });

const COMMITTED = `${NS}/committed`;
const AGENT = `${NS}/agent`;
const BROKEN = `${NS}/broken`;
const LAUNCH = `${NS}/launch`;
const jobIds = [`onb-${stamp}-warm`, `onb-${stamp}-old`, `onb-${stamp}-wait`, `onb-${stamp}-race`];
const VALUE = `s3cr3t-value-${stamp}`;
const logged: string[] = [];
const realLog = console.log;
const realError = console.error;

try {
  // Add repository: owner only, only what the App reaches and nothing registered, then the row, its intent and its label.
  await insert(`${NS}/taken`, null);
  const installable = { repos: [{ repo: `${NS}/taken`, private: false, description: null }, { repo: `${NS}/fresh`, private: true, description: "d" }], manageUrl: "https://github.com/settings/installations/1" };
  const labels: unknown[] = [];
  const addDeps = (user: typeof owner | null = owner) => ({
    user: async () => user,
    registry: async () => db.select().from(repoSettings),
    installable: async () => installable,
    create: (repo: string, by: string) => actions.writeNewRepository(db, repo, by, new Date()),
    syncLabels: async (groups: unknown) => (labels.push(groups), { created: [], problems: [] }),
  });
  for (const user of [null, { email: "x@example.com", emailVerified: true }]) {
    assert.equal((await actions.listAddable(addDeps(user))).ok, false, "only the owner lists");
    assert.equal((await actions.addRepository(addDeps(user), { repo: `${NS}/fresh` })).ok, false, "or adds");
  }
  const listed = await actions.listAddable(addDeps());
  assert.deepEqual(listed.ok && listed.repos.map((r) => r.repo), [`${NS}/fresh`], "registered repos are left out");
  assert.equal(listed.ok && listed.manageUrl, "https://github.com/settings/installations/1");
  assert.match(JSON.stringify(await actions.addRepository(addDeps(), { repo: `${NS}/taken` })), /already registered/);
  assert.match(JSON.stringify(await actions.addRepository(addDeps(), { repo: `${NS}/unreachable` })), /cannot reach/);
  assert.deepEqual(await actions.addRepository(addDeps(), { repo: `${NS}/fresh` }), { ok: true });
  const fresh = await row(`${NS}/fresh`);
  assert.deepEqual([fresh.enabled, fresh.is_default, fresh.onboarding_state, fresh.updated_by], [true, false, "analyzing", OWNER]);
  const freshIntents = await db.select().from(intents).where(eq(intents.detail, `${NS}/fresh`));
  assert.deepEqual(freshIntents.map((i) => i.kind), ["onboard_repo"], "a runner is asked to onboard it");
  assert.deepEqual(labels, [[{ group: "Repository", children: ["fresh"] }]], "its Repository label child is added");

  // A committed recipe skips the agent: the build validates it and its checks run.
  committed[COMMITTED] = JSON.stringify(valid);
  await insert(COMMITTED, "analyzing");
  const begun = await runner.onboardRepo(COMMITTED);
  assert.equal((begun as { recipe?: string }).recipe, "committed", JSON.stringify(begun));
  let d = await detail(COMMITTED);
  assert.equal((await row(COMMITTED)).onboarding_state, "building");
  assert.deepEqual([d.recipeSource, d.run?.kind, d.run?.checks, d.run?.machine], ["committed", "build", true, TEST_MACHINE_ID]);
  const builder = sandboxOf(d.run?.sandboxId);
  assert.ok(!builder.execs.some((e) => e.argv[0] === "t3"), "no agent thread for a committed recipe");
  assert.equal(builder.spec!.imageId, "im-base", "the build starts from the base image");
  assert.equal(builder.spec!.tags.purpose, "onboarding");
  assert.equal(builder.spec!.tags.label, undefined, "the job reap never sees it");
  assert.match(builder.files.get(BUILD_FILES.script)!, /libvips-dev/);
  assert.ok(builder.execs.some((e) => e.argv.join(" ") === `git clone --quiet https://github.com/${COMMITTED}.git ${REPO_DIR}`));
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await row(COMMITTED)).onboarding_state, "building", "a build still running stays building");
  await finishBuild(COMMITTED, 0);
  await runner.advanceOnboarding({ only: await ours() });
  const built = await row(COMMITTED);
  d = onboarding.parseDetail(built.onboarding_detail);
  assert.equal(built.onboarding_state, "ready");
  assert.deepEqual([d.image?.id.startsWith("im-snap-"), d.image?.commit, d.image?.recipeHash, d.image?.base], [true, "abc1234def", recipeHash(recipe), base]);
  assert.deepEqual(d.checks?.map((c) => [c.name, c.ok]), [["test", true], ["lint", false]], "the committed recipe's checks are recorded");
  assert.equal(d.run, undefined);
  assert.equal(builder.terminated, true);
  assert.equal(fake.images.get(d.image!.id)?.has(GITHUB_TOKEN_PATH), false, "the image holds no GitHub token");
  assert.ok(builder.execs.some((e) => e.argv.join(" ") === `rm -rf /work/onboarding ${GITHUB_TOKEN_PATH}`), "nor the build's files");
  assert.equal(fake.snapshots.at(-1)!.ttlMs, null, "and is kept for good");

  // A push: unrelated files leave it; a lockfile rebuilds with the old image serving; a recipe change takes main's recipe.
  assert.match(JSON.stringify(await runner.repoPushed({ repo: COMMITTED, files: ["src/a.ts"] })), /nothing the warm image depends on changed/);
  const firstImage = d.image!.id;
  await runner.repoPushed({ repo: COMMITTED.toUpperCase(), files: ["bun.lock"] });
  assert.equal((await row(COMMITTED)).onboarding_state, "rebuilding", "a lockfile change rebuilds");
  d = await detail(COMMITTED);
  assert.deepEqual([d.image?.id, d.run?.kind, d.run?.checks], [firstImage, "build", false], "the old image serves, and an unchanged recipe is not checked again");
  assert.equal(onboarding.repoImage(await row(COMMITTED), base).kind, "warm");
  await runner.repoPushed({ repo: COMMITTED, files: ["bun.lock"] });
  assert.ok((await detail(COMMITTED)).rebuild, "a push during a build wants another one after it");
  await finishBuild(COMMITTED, 0);
  await runner.advanceOnboarding({ only: await ours() });
  d = await detail(COMMITTED);
  assert.notEqual(d.image?.id, firstImage);
  assert.ok(fake.deletedImages.includes(firstImage), "the old image is deleted once the new one is recorded");
  assert.equal(d.run?.kind, "build", "and the wanted rebuild starts");
  await finishBuild(COMMITTED, 0);
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await row(COMMITTED)).onboarding_state, "ready");
  committed[COMMITTED] = JSON.stringify({ ...valid, setup: ["bun install"] });
  await runner.repoPushed({ repo: COMMITTED, files: [".factory/setup.json"] });
  d = await detail(COMMITTED);
  assert.deepEqual([d.recipe?.setup, d.run?.reason, (await row(COMMITTED)).onboarding_state], [["bun install"], "the recipe changed on main", "rebuilding"], "a merged recipe change rebuilds from main's recipe");
  assert.equal(d.run?.checks, true, "and a changed committed recipe is checked again");
  await finishBuild(COMMITTED, 20, "== setup 1: bun install\nDATABASE_URL=postgres://u:pw@h/db\nerror: lockfile had changes");
  await runner.advanceOnboarding({ only: await ours() });
  const broke = await row(COMMITTED);
  d = onboarding.parseDetail(broke.onboarding_detail);
  assert.equal(broke.onboarding_state, "failed");
  assert.equal(d.failure?.reason, "The image build failed: a setup command failed.");
  assert.match(d.failure!.log!, /lockfile had changes/);
  assert.doesNotMatch(d.failure!.log!, /u:pw/, "a log excerpt holds no credentials");
  assert.equal(onboarding.repoImage(broke, base).kind, "warm", "the last good image still serves");

  // A base image re-pinned or rebuilt: ready repos rebuild lazily, one at a time.
  await db.update(repoSettings).set({ onboarding_state: "ready" }).where(eq(repoSettings.repo, COMMITTED));
  const rebuiltBase = { ...baseImage, builtAt: "2026-10-28T00:00:00.000Z" };
  sandboxRuntime.image = () => rebuiltBase;
  await runner.advanceOnboarding({ only: await ours() });
  d = await detail(COMMITTED);
  assert.deepEqual([(await row(COMMITTED)).onboarding_state, d.run?.reason, d.run?.kind], ["rebuilding", "the base image was rebuilt since", "build"]);
  await finishBuild(COMMITTED, 0);
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await detail(COMMITTED)).image?.base.builtAt, rebuiltBase.builtAt);
  sandboxRuntime.image = () => baseImage;
  await db.update(repoSettings).set({ enabled: false }).where(eq(repoSettings.repo, COMMITTED));

  // No recipe on main: one agent thread writes it, the result comes back, the sandbox goes.
  // The slot is leased before the sandbox exists: a job leasing while it is created cannot take it.
  const { leaseSlot } = await import("../runner/lifecycle");
  const raceKey = `ONBR-${stamp % 100000}`;
  await db.insert(jobs).values(linearJob(jobIds[3]!, raceKey, { repo: LAUNCH }));
  const leases = async () => (await db.select().from(codexSlotLeases).where(inArray(codexSlotLeases.slot, [slotA, slotB]))).map((l) => [l.slot, l.holder_kind, l.holder_id]);
  await insert(AGENT, "analyzing");
  let raced: string | undefined = "not tried";
  let recordedWhileCreating: unknown;
  modal.api = {
    ...fakeModal,
    create: async (spec) => {
      raced = await leaseSlot(eq(jobs.key, raceKey), [slotA]);
      const run = (await detail(AGENT)).run;
      recordedWhileCreating = [run?.kind, run?.slot, run?.sandboxId, await leases()];
      return fakeModal.create(spec);
    },
  };
  const agentStart = await runner.onboardRepo(AGENT);
  modal.api = fakeModal;
  assert.deepEqual(agentStart, { repo: AGENT, agent: "thread-onb" });
  assert.equal(raced, undefined, "a job cannot lease the slot an onboarding run took while its sandbox is created");
  assert.deepEqual(recordedWhileCreating, ["agent", slotA, undefined, [[slotA, "onboarding", AGENT]]], "the lease and the run holding it are written together, before the sandbox");
  assert.deepEqual(await leases(), [[slotA, "onboarding", AGENT]], "the run holds the slot's lease");
  await assert.rejects(db.update(jobs).set({ codex_slot: slotA }).where(eq(jobs.key, raceKey)), (e: { cause?: { code?: string } }) => e.cause?.code === "23505", "nor can a job be written onto it");
  d = await detail(AGENT);
  assert.deepEqual([d.run?.kind, d.run?.threadId, d.run?.slot], ["agent", "thread-onb", slotA]);
  const agentBox = sandboxOf(d.run?.sandboxId);
  const startExec = agentBox.execs.find((e) => e.argv.slice(0, 3).join(" ") === "t3 thread start")!;
  assert.ok(startExec.argv.includes("factory/onboarding"), "the thread works on factory/onboarding");
  assert.match(startExec.input, /# Onboarding a repository/, "with the onboarding playbook");
  assert.match(startExec.input, /\/work\/onboarding\/result\.json/);
  assert.equal(agentBox.files.has("/root/.config/marshal-factory/config.json"), false, "an onboarding run reports to no job");
  assert.match(JSON.stringify(await runner.onboardRepo(AGENT)), /an agent run is in flight/, "a second onboard waits for the first");
  assert.equal(await leaseSlot(eq(jobs.key, raceKey), [slotA]), undefined, "a job cannot lease the slot the agent holds");
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await detail(AGENT)).run?.kind, "agent", "a running thread is left alone");
  threadState = "stopped";
  const agentRecipe = { ...valid, env: [{ name: "API_KEY", purpose: "the payments sandbox", required: true }] };
  agentBox.files.set(runner.ONBOARDING_RESULT, JSON.stringify({ recipe: agentRecipe, prUrl: `https://github.com/${AGENT}/pull/7`, checks: [{ name: "test", command: "bun test", ok: true }], summary: "Installs with bun." }));
  await runner.advanceOnboarding({ only: await ours() });
  const agentRow = await row(AGENT);
  d = onboarding.parseDetail(agentRow.onboarding_detail);
  assert.equal(agentRow.onboarding_state, "needs_input", "a required env var without a value waits for the owner");
  assert.deepEqual([d.recipeSource, d.recipePr, d.missingSecrets, d.run, d.checks?.length], ["agent", `https://github.com/${AGENT}/pull/7`, ["API_KEY"], undefined, 1]);
  assert.equal(agentBox.terminated, true, "the onboarding sandbox is torn down");
  assert.deepEqual(await leases(), [], "and its slot's lease is released");
  threadState = "running";

  // A run that never gets recorded hands its lease back: here the sandbox cannot be created.
  const FLAKY = `${NS}/flaky`;
  await insert(FLAKY, "analyzing");
  modal.api = { ...fakeModal, create: async () => Promise.reject(new Error("modal is down")) };
  await assert.rejects(runner.onboardRepo(FLAKY), /modal is down/);
  modal.api = fakeModal;
  assert.deepEqual(await leases(), [], "a failed sandbox create releases the slot");
  assert.equal(await leaseSlot(eq(jobs.key, raceKey), [slotA]), slotA, "which a job can then lease");
  assert.deepEqual(await leases(), [[slotA, "job", jobId("linear", jobIds[3]!)]]);
  await db.update(jobs).set({ codex_slot: null }).where(eq(jobs.key, raceKey));
  assert.deepEqual(await leases(), [], "clearing the job's slot releases it");

  // A runner that dies between taking the slot and creating the sandbox: the next tick hands the slot back.
  const DIED = `${NS}/died`;
  await insert(DIED, "analyzing", { run: { kind: "agent", machine: TEST_MACHINE_ID, startedAt: new Date().toISOString(), slot: slotA } });
  assert.deepEqual(await leases(), [[slotA, "onboarding", DIED]]);
  await runner.advanceOnboarding({ only: await ours() });
  d = await detail(DIED);
  assert.deepEqual([(await row(DIED)).onboarding_state, d.run, await leases()], ["failed", undefined, []], "the abandoned run is cleared and its lease released");
  assert.match(d.failure!.reason, /stopped before its sandbox was created/);

  // Leases no job or onboarding run records, such as one an older runner left between leasing and recording, are reaped.
  const longAgo = new Date(Date.now() - ORPHAN_LEASE_MS - 60_000);
  await db.insert(codexSlotLeases).values([
    { slot: slotA, holder_kind: "onboarding", holder_id: DIED, leased_at: longAgo },
    { slot: slotB, holder_kind: "job", holder_id: jobId("linear", jobIds[3]!), leased_at: longAgo },
  ]);
  assert.deepEqual((await releaseOrphanLeases()).sort(), [slotA, slotB].sort());
  assert.deepEqual(await leases(), [], "orphan leases are released");
  await db.insert(codexSlotLeases).values({ slot: slotA, holder_kind: "onboarding", holder_id: DIED });
  assert.deepEqual(await releaseOrphanLeases(), [], "a fresh lease is left to the runner taking it");
  await db.delete(codexSlotLeases).where(eq(codexSlotLeases.slot, slotA));
  await db.update(jobs).set({ codex_slot: slotA }).where(eq(jobs.key, raceKey));
  assert.deepEqual(await releaseOrphanLeases(Date.now() + 2 * ORPHAN_LEASE_MS), [], "a lease its job still records stays");
  await db.update(jobs).set({ codex_slot: null }).where(eq(jobs.key, raceKey));

  // Secrets: the value goes to the store and nowhere else; the names are recorded and the build starts.
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  const stored = new Map<string, Record<string, string>>();
  let upsertFails = false;
  const secretDeps = (configured = true, user: typeof owner | null = owner) => ({
    user: async () => user,
    registry: async () => db.select().from(repoSettings),
    modalConfigured: () => configured,
    upsert: async (name: string, entries: Record<string, string>) => {
      if (upsertFails) throw new Error(`rejected ${Object.values(entries).join(",")}`);
      stored.set(name, { ...stored.get(name), ...entries });
    },
    recordNames: (repo: string, names: string[]) => actions.recordSecretNames(db, repo, names, new Date()),
  });
  assert.equal((await actions.saveRepoSecrets(secretDeps(true, null), { repo: AGENT, values: { API_KEY: VALUE } })).ok, false, "only the owner saves secrets");
  assert.match(JSON.stringify(await actions.saveRepoSecrets(secretDeps(false), { repo: AGENT, values: { API_KEY: VALUE } })), /bun scripts\/repo-secret.ts .+ API_KEY/, "without a Modal token the panel points to the CLI");
  assert.match(JSON.stringify(await actions.saveRepoSecrets(secretDeps(), { repo: AGENT, values: { OTHER: VALUE } })), /names no env var OTHER/);
  upsertFails = true;
  const refused = await actions.saveRepoSecrets(secretDeps(), { repo: AGENT, values: { API_KEY: VALUE } });
  assert.equal(refused.ok, false);
  assert.ok(!JSON.stringify(refused).includes(VALUE), "an error never echoes the value");
  upsertFails = false;
  assert.deepEqual(await actions.saveRepoSecrets(secretDeps(), { repo: AGENT, values: { API_KEY: VALUE } }), { ok: true });
  assert.deepEqual(stored.get(onboarding.modalSecretName(AGENT)), { API_KEY: VALUE }, "the value is in the repo's Modal secret");
  d = await detail(AGENT);
  assert.deepEqual([(await row(AGENT)).onboarding_state, d.secretsSet, d.missingSecrets], ["building", ["API_KEY"], []], "names only, and on to building");
  const leaks = await db.execute(sql`
    select (select count(*) from repo_settings where onboarding_detail::text like ${`%${VALUE}%`})
         + (select count(*) from intents where coalesce(detail, '') || coalesce(result, '') like ${`%${VALUE}%`})
         + (select count(*) from events where payload::text like ${`%${VALUE}%`}) as n`);
  assert.equal(Number((leaks.rows[0] as { n: string | number }).n), 0, "no table holds the value");
  const rebuildIntent = (await db.select().from(intents).where(eq(intents.detail, AGENT))).map((i) => i.kind);
  assert.deepEqual(rebuildIntent, ["rebuild_repo_image"], "a runner is asked to build");
  console.log = realLog;
  console.error = realError;
  assert.ok(!logged.some((l) => l.includes(VALUE)), "and no log line holds it");
  await runner.requestRebuild(AGENT, "the owner asked for a rebuild");
  d = await detail(AGENT);
  const agentBuild = sandboxOf(d.run?.sandboxId);
  assert.deepEqual(agentBuild.spec!.namedSecrets, [onboarding.modalSecretName(AGENT)], "the build sandbox gets the repo's secret by name");
  assert.equal(d.run?.checks, false, "an agent's recipe was checked by the agent");
  await finishBuild(AGENT, 0);
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await row(AGENT)).onboarding_state, "ready");
  await db.update(repoSettings).set({ enabled: false }).where(eq(repoSettings.repo, AGENT));

  // Failure paths: an agent that writes no result, or gives up, fails the row with why.
  await insert(BROKEN, "analyzing");
  await runner.onboardRepo(BROKEN);
  threadState = "stopped";
  await runner.advanceOnboarding({ only: await ours() });
  d = await detail(BROKEN);
  assert.deepEqual([(await row(BROKEN)).onboarding_state, d.failure?.reason, d.failure?.log], ["failed", "The onboarding agent ended without writing its result.", "I wrote the recipe."]);
  threadState = "running";
  await actions.writeRepoRequest(db, "onboard_repo", BROKEN, new Date());
  assert.deepEqual([(await row(BROKEN)).onboarding_state, (await detail(BROKEN)).failure], ["analyzing", undefined], "Retry onboarding starts over");
  await runner.onboardRepo(BROKEN);
  threadState = "stopped";
  sandboxOf((await detail(BROKEN)).run?.sandboxId).files.set(runner.ONBOARDING_RESULT, JSON.stringify({ failed: "the repo needs a running Postgres for every check" }));
  await runner.advanceOnboarding({ only: await ours() });
  assert.equal((await detail(BROKEN)).failure?.reason, "The onboarding agent could not write a recipe: the repo needs a running Postgres for every check");
  threadState = "running";
  sandboxRuntime.image = () => null;
  await actions.writeRepoRequest(db, "onboard_repo", BROKEN, new Date());
  await runner.onboardRepo(BROKEN);
  assert.match((await detail(BROKEN)).failure!.reason, /^Modal cannot start the onboarding sandbox: no sandbox image is built/);
  sandboxRuntime.image = () => baseImage;

  // Launch: a ready repo starts from its warm image, refreshed instead of cloned; outdated falls back; not onboarded waits.
  const launchImage = { ...warmImage, id: "im-warm-launch" };
  fake.images.set("im-warm-launch", new Map());
  fake.images.set("im-base", new Map());
  await insert(LAUNCH, "ready", { recipe, recipeSource: "committed", image: launchImage, secretsSet: ["API_KEY"] });
  await db.insert(jobs).values(jobIds.slice(0, 3).map((id, i) => linearJob(id, `ONB${i}-${stamp % 100000}`, { repo: LAUNCH })));
  const slot = { id: TEST_MACHINE_ID, repos: [LAUNCH], maxInFlight: 1000 };
  sandboxRuntime.slots = () => [slotA, slotB];
  config.factory.sandbox.maxParallel = 100;
  const entry = (i: number) => ({ key: `ONB${i}-${stamp % 100000}`, sandbox_id: null, attempt: 1, budgetUsd: 5, source: "linear" as const, repo: LAUNCH, branch: `factory/ONB${i}`, threadTitle: "t", message: "Work it", harness: { provider: "codex", model: "gpt-6-astra" }, ticket: null });
  fake.answer = (_sandbox, argv) => (argv.slice(0, 3).join(" ") === "t3 thread start" ? { stdout: '{"threadId":"thread-warm"}' } : argv[0] === "claude" ? { stdout: "[]" } : {});
  const registryNow = async () => db.select().from(repoSettings).where(eq(repoSettings.repo, LAUNCH));
  const [warmLaunch] = await launchInSandboxes([entry(0)], slot, async () => {}, await registryNow());
  assert.equal(warmLaunch!.threadId, "thread-warm", JSON.stringify(warmLaunch));
  const [warmJob] = await db.select().from(jobs).where(eq(jobs.id, jobId("linear", jobIds[0]!)));
  const warmBox = sandboxOf(warmJob!.sandbox_id!);
  assert.equal(warmBox.spec!.imageId, "im-warm-launch", "the job starts from the warm image");
  assert.deepEqual(warmBox.spec!.namedSecrets, [onboarding.modalSecretName(LAUNCH)], "with the repo's secret");
  const argvs = warmBox.execs.map((e) => e.argv.join(" "));
  assert.ok(!argvs.some((a) => a.startsWith("git clone")), "nothing is cloned");
  assert.ok(argvs.includes(`git -C ${REPO_DIR} checkout --quiet -B main origin/main`), "the checkout moves to origin/main");
  assert.ok(argvs.includes(`bash -c ${recipe.setup[0]}`), "and setup runs again");
  assert.match(warmBox.execs.find((e) => e.argv[2] === "start")!.input, /setup recipe is \.factory\/setup\.json/, "the thread is told about the recipe");
  assert.equal(warmBox.files.has(recipes.UNMERGED_RECIPE_PATH), false, "a recipe on main is read from the worktree");
  // A recipe only on the onboarding PR is not in the worktree, cut from main: the thread gets its commands, factory-verify a copy.
  const prDetail = { recipe, recipeSource: "agent" as const, recipePr: `https://github.com/${LAUNCH}/pull/3`, image: launchImage, secretsSet: ["API_KEY"] };
  await db.update(repoSettings).set({ onboarding_detail: prDetail }).where(eq(repoSettings.repo, LAUNCH));
  sandboxRuntime.image = () => ({ ...baseImage, builtAt: "2026-10-29T00:00:00.000Z" });
  await launchInSandboxes([entry(1)], slot, async () => {}, await registryNow());
  const [oldJob] = await db.select().from(jobs).where(eq(jobs.id, jobId("linear", jobIds[1]!)));
  const oldBox = sandboxOf(oldJob!.sandbox_id!);
  const prMessage = oldBox.execs.find((e) => e.argv[2] === "start")!.input;
  assert.doesNotMatch(prMessage, /setup recipe is \.factory\/setup\.json/, "the thread is not sent to a recipe its worktree lacks");
  assert.match(prMessage, /not on main yet \(it waits in https:\/\/github\.com\/.+\/pull\/3\)/);
  assert.ok(prMessage.includes(`    ${recipe.setup[0]}`) && prMessage.includes(`    test: ${recipe.checks!.test}`), "it gets the setup and check commands inline");
  assert.deepEqual(JSON.parse(oldBox.files.get(recipes.UNMERGED_RECIPE_PATH)!), recipe, "and factory-verify gets the recipe in the sandbox");
  assert.equal(oldBox.spec!.imageId, "im-base", "an outdated warm image falls back to the base image");
  assert.ok(oldBox.execs.some((e) => e.argv[0] === "git" && e.argv[1] === "clone"), "which clones as before");
  assert.ok(events.some((e) => e.event === "sandbox:warm-image-outdated"));
  sandboxRuntime.image = () => baseImage;
  await db.update(repoSettings).set({ onboarding_state: "analyzing", onboarding_detail: {} }).where(eq(repoSettings.repo, LAUNCH));
  assert.deepEqual(await launchInSandboxes([entry(2)], slot, async () => {}, await registryNow()), [], "a repo still onboarding launches nothing on Modal");
  assert.equal((await db.select().from(jobs).where(eq(jobs.id, jobId("linear", jobIds[2]!))))[0]!.t3_thread_id, null);

  console.log("onboarding regressions passed");
} catch (error) {
  console.log = realLog;
  console.error = realError;
  console.error(error);
  process.exitCode = 1;
} finally {
  console.log = realLog;
  console.error = realError;
  await db.delete(jobs).where(inArray(jobs.id, jobIds.map((id) => jobId("linear", id))));
  await db.delete(intents).where(like(intents.detail, `${NS}/%`));
  await db.delete(repoSettings).where(like(repoSettings.repo, `${NS}/%`));
  await db.delete(codexSlotLeases).where(inArray(codexSlotLeases.slot, [slotA, slotB]));
  process.exit(process.exitCode ?? 0);
}
