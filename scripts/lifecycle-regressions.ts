import "./test-guard";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { fake, fakeModal, FakeSandbox, sandboxes } from "./fake-modal";

const { db } = await import("../db/client");
const { auditLog, jobs, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { ensureAwake, HostAsleepError, hosts } = await import("../lib/host");
const { modal } = await import("../lib/modal-host");
const { CODEX_AUTH, GITHUB_TOKEN_PATH, readSlotHealth, sandboxReadiness } = await import("../lib/sandbox");
const { github } = await import("../lib/github/pulls");
const { canReclaim, canReclaimSql } = await import("../runner/binding");
const { checkPullRequests, config, deliverStops, reconcileUsage, resumeAnswered, sandboxesInFlight, threads, toLaunch, watchdog } = await import("../runner/ops");
const { hibernateIdle, reap, refreshTokens, teardownFinished, tickSandboxes, TOKEN_REFRESH_MS } = await import("../runner/lifecycle");
const { launchInSandboxes } = await import("../runner/launch");
const { CodexLoginError, sandboxRuntime, usableSlots } = await import("../runner/sandbox");

modal.api = fakeModal;

const stamp = Date.now() % 1_000_000;
const label = config.factory.label;
const limits = config.factory.sandbox;
const dir = mkdtempSync(join(tmpdir(), "lifecycle-regress-"));
const slotA = mkdtempSync(join(dir, "slot-a-"));
const slotB = mkdtempSync(join(dir, "slot-b-"));
const slotC = mkdtempSync(join(dir, "slot-c-"));
const healthPath = join(dir, "codex-slots.json");
for (const slot of [slotA, slotB, slotC]) writeFileSync(join(slot, "auth.json"), `{"slot":"${slot}","v":1}`, { mode: 0o600 });
const authOf = (slot: string) => readFileSync(join(slot, "auth.json"), "utf8");

const events: { event: string; detail: Record<string, unknown> }[] = [];
let minted = 0;
let claudeToken: string | undefined;
Object.assign(sandboxRuntime, {
  image: () => ({ imageId: "im-test", t3Version: limits.t3Version, factoryCommit: "abc", builtAt: "now" }),
  claudeToken: () => claudeToken,
  githubToken: async () => `ghs_fake_${++minted}`,
  slots: () => [slotA, slotB, slotC],
  driverOf: (provider: string) => provider,
  log: (event: string, detail: Record<string, unknown>) => void events.push({ event, detail }),
  slotHealthPath: healthPath,
});

// Thread state per thread id, and whether Codex and Claude accept their logins.
const running = new Set<string>();
const archived = new Set<string>();
let codexOk = true;
let claudeOk = true;
fake.answer = (_sandbox, argv) => {
  const line = argv.join(" ");
  if (line.startsWith("t3 thread show ")) {
    return { stdout: JSON.stringify({ thread: { archived: archived.has(argv[3]!), worktreePath: null, activeRunId: running.has(argv[3]!) ? "run-1" : null, branch: null } }) };
  }
  if (line === "codex login status") return { code: codexOk ? 0 : 1, stdout: codexOk ? "Logged in using ChatGPT" : "Not logged in" };
  if (line === "claude auth status") return { code: claudeOk ? 0 : 1 };
  if (argv[0] === "t3" && argv[1] === "thread" && argv[2] === "start") return { stdout: '{"threadId":"thread-launched"}' };
  return {};
};

const key = (name: string) => `LC${name}-${stamp}`;
const ids: string[] = [];
const runKeys: string[] = [];
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const hourAgo = new Date(Date.now() - 3_600_000);

async function sandboxFor(k: string, machine = TEST_MACHINE_ID) {
  return (await fakeModal.create({ name: `job-${k}-a1`, tags: { job: k, attempt: "1", label, machine }, imageId: "im-test", secrets: {}, env: {}, encryptedPorts: [], limits })) as FakeSandbox;
}

async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = key(name);
  ids.push(`lifecycle-regress-${k}`);
  await db.insert(jobs).values(linearJob(`lifecycle-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, stage_at: hourAgo, ...over }));
  return k;
}

try {
  // Hibernate: a pr job whose thread settled gives its sandbox up; its refreshed login goes back first.
  const sbH = await sandboxFor(key("H"));
  sbH.files.set(CODEX_AUTH, `{"slot":"${slotA}","v":2}`);
  sbH.files.set("/work/repo/marker.txt", "kept");
  const H = await insert("H", { stage: "pr", t3_thread_id: "thread-H", sandbox_id: sbH.sandboxId, codex_slot: slotA, pr_url: `https://github.com/ski043/factory-demo/pull/${stamp}` });
  const sbRun = await sandboxFor(key("RUN"));
  const RUN = await insert("RUN", { stage: "pr", t3_thread_id: "thread-RUN", sandbox_id: sbRun.sandboxId, codex_slot: slotB });
  running.add("thread-RUN");
  const sbFresh = await sandboxFor(key("FRESH"));
  const FRESH = await insert("FRESH", { stage: "waiting", t3_thread_id: "thread-FRESH", sandbox_id: sbFresh.sandboxId, stage_at: new Date() });

  const hibernated = await hibernateIdle();
  assert.deepEqual(hibernated, [`${H}:hibernated`], JSON.stringify(hibernated));
  const h = await row(H);
  assert.deepEqual([h.sandbox_id, h.codex_slot, h.sandbox_snapshot], [null, null, "im-snap-1"], "snapshot recorded, sandbox and slot cleared");
  assert.equal(authOf(slotA), `{"slot":"${slotA}","v":2}`, "the sandbox's refreshed login is written back to the slot");
  assert.equal(statSync(join(slotA, "auth.json")).mode & 0o777, 0o600, "owner-only");
  assert.ok(sbH.terminated, "the sandbox is terminated");
  const opsH = fake.ops.filter((o) => o.startsWith(`${sbH.sandboxId}:`));
  const at = (needle: string) => opsH.findIndex((o) => o.includes(needle));
  assert.ok(at("pkill") >= 0 && at("pkill") < at("snapshot") && at("snapshot") < at("terminated"), `t3 serve stops, then snapshot, then terminate: ${opsH.join(" | ")}`);
  assert.equal(fake.snapshots[0]!.ttlMs, limits.snapshotTtlDays * 86_400_000, "the snapshot expires after snapshotTtlDays");
  assert.ok(!events.some((e) => JSON.stringify(e).includes('"v":2')), "no login contents are logged");
  assert.equal((await row(RUN)).sandbox_id, sbRun.sandboxId, "a running thread keeps its sandbox");
  assert.equal((await row(FRESH)).sandbox_id, sbFresh.sandboxId, "a job inside hibernateAfterMinutes keeps its sandbox");
  assert.deepEqual(await hibernateIdle(), [], "a second pass changes nothing");

  // A hibernated job has no host until something wakes it, and looking never wakes it.
  await assert.rejects(hosts.forJob(h).run("echo", []), HostAsleepError);
  const createdBefore = fake.created;
  await db.update(jobs).set({ stage: "implementing" }).where(eq(jobs.key, H));
  assert.ok(!(await watchdog()).some((a) => a.startsWith(H)), "the watchdog skips a hibernated job");
  await db.update(jobs).set({ stage: "pr", stop_event_id: `stop:${H}:1:x`, stop_sent_to: null }).where(eq(jobs.key, H));
  assert.deepEqual(await deliverStops(h.id), [H], "a stop owed to a hibernated thread is settled without waking it");
  assert.equal((await row(H)).stop_sent_to, "thread-H");
  await db.update(jobs).set({ stop_event_id: null, stop_sent_to: null }).where(eq(jobs.key, H));
  assert.equal(fake.created, createdBefore, "no sandbox was started for any of that");

  // Wake: a conflict send-back starts a sandbox from the snapshot with a fresh slot, token and T3, then sends.
  github.pullRequest = async (url) => ({ state: "open", mergeable: url === h.pr_url ? "conflicting" : "mergeable", headSha: "head-1", title: "t" });
  const checked = await checkPullRequests();
  assert.deepEqual(checked.conflicts, [], "the implementing event cannot post in a regression");
  assert.match(checked.errors.find((e) => e.key === H)?.error ?? "", /deployed ingest function/, JSON.stringify(checked));
  const woken = await row(H);
  const sbW = sandboxes.get(woken.sandbox_id!)!;
  assert.equal(sbW.spec!.imageId, "im-snap-1", "started from the snapshot");
  assert.equal(sbW.spec!.name, `job-${H}-a1`);
  assert.deepEqual(sbW.spec!.tags, { job: H, attempt: "1", label, machine: TEST_MACHINE_ID });
  assert.deepEqual([woken.sandbox_snapshot, woken.codex_slot, woken.conflict_head], [null, slotA, "head-1"], "snapshot cleared, the free slot leased, the conflict claimed");
  assert.ok(fake.deletedImages.includes("im-snap-1"), "the snapshot is deleted once the sandbox serves");
  assert.equal(sbW.files.get("/work/repo/marker.txt"), "kept", "the worktree survived");
  assert.equal(sbW.files.get(CODEX_AUTH), authOf(slotA), "the leased slot's login");
  assert.match(sbW.files.get(GITHUB_TOKEN_PATH)!, /^ghs_fake_\d+$/, "a fresh GitHub token");
  const argvW = sbW.execs.map((e) => e.argv.join(" "));
  const w = (needle: string) => argvW.findIndex((a) => a.includes(needle));
  assert.ok(w("codex login status") >= 0 && w("codex login status") < w("t3 serve") && w("rm -rf /root/.t3/userdata/server-runtime.json") < w("t3 serve"), argvW.join(" | "));
  assert.ok(w("t3 serve") < w("t3 thread send thread-H"), "serve before the message");
  assert.deepEqual(sbW.spec!.encryptedPorts, [3773], "a woken sandbox declares T3's port as an encrypted tunnel");
  assert.match(argvW[w("t3 serve")]!, /serve --host 0\.0\.0\.0 --port 3773 /, "and T3 listens where the tunnel reaches it");
  assert.match(sbW.execs[w("t3 thread send")]!.input, /conflicts with main/);

  // Token refresh: every 40 minutes per running sandbox; one this runner has no record of goes at once.
  const now = Date.now();
  minted = 100;
  const sorted = (result: unknown) => (Array.isArray(result) ? [...result].sort() : result);
  assert.deepEqual(sorted(await refreshTokens(now)), [`${RUN}:token`, `${FRESH}:token`].sort(), "unknown sandboxes refresh, the just-woken one does not");
  assert.match(sbRun.files.get(GITHUB_TOKEN_PATH)!, /^ghs_fake_10[12]$/);
  assert.deepEqual(await refreshTokens(now + 10 * 60_000), [], "nothing is due ten minutes later");
  const due = await refreshTokens(now + TOKEN_REFRESH_MS + 60_000);
  assert.ok(Array.isArray(due) && due.includes(`${H}:token`) && due.includes(`${RUN}:token`), JSON.stringify(due));
  assert.ok(!sbRun.execs.some((e) => e.argv.join(" ").includes("ghs_fake")), "the token never appears in a command line");

  // Teardown: a merged job writes its login back, ends its sandbox and frees its slot, once.
  sbW.files.set(CODEX_AUTH, `{"slot":"${slotA}","v":3}`);
  await db.update(jobs).set({ stage: "merged" }).where(eq(jobs.key, H));
  const snapGone = await insert("GONE", { stage: "failed", t3_thread_id: "thread-GONE", sandbox_snapshot: "im-snap-expired", stop_event_id: `stop:${key("GONE")}:1:x` });
  fake.images.set("im-snap-kept", new Map());
  const SNAP = await insert("SNAP", { stage: "failed", t3_thread_id: "thread-SNAP", sandbox_snapshot: "im-snap-kept" });
  const sqlReclaims = async (k: string) => (await db.select({ ok: sql<boolean>`coalesce(${canReclaimSql}, false)` }).from(jobs).where(eq(jobs.key, k)))[0]!.ok;
  assert.equal(canReclaim(await row(SNAP)), false, "a failed job holding a snapshot cannot start a new attempt yet");
  assert.equal(await sqlReclaims(SNAP), false, "SQL agrees");
  const torn = await teardownFinished();
  assert.ok(Array.isArray(torn) && [H, snapGone, SNAP].every((k) => torn.includes(`${k}:torn down`)), JSON.stringify(torn));
  assert.equal(authOf(slotA), `{"slot":"${slotA}","v":3}`, "written back before the sandbox ends");
  assert.ok(sbW.terminated);
  for (const k of [H, snapGone, SNAP]) {
    const r = await row(k);
    assert.deepEqual([r.sandbox_id, r.sandbox_snapshot, r.codex_slot], [null, null, null], `${k} holds nothing`);
  }
  assert.ok(fake.deletedImages.includes("im-snap-kept"), "the snapshot image is deleted");
  assert.equal((await row(snapGone)).stop_sent_to, "thread-GONE", "a stop owed to a thread that ended with its sandbox is settled");
  assert.equal(canReclaim(await row(SNAP)), true, "and then a retry may claim");
  assert.equal(await sqlReclaims(SNAP), true, "SQL agrees");
  assert.deepEqual(await teardownFinished(), [], "teardown is idempotent");

  // Wake with a login Codex refuses: the slot is marked, the new sandbox ends, the snapshot stays.
  fake.images.set("im-snap-w", new Map([["/work/repo/marker.txt", "w"]]));
  const W = await insert("W", { stage: "waiting", t3_thread_id: "thread-W", sandbox_snapshot: "im-snap-w" });
  codexOk = false;
  await assert.rejects(ensureAwake(await row(W)), CodexLoginError);
  const failedWake = await row(W);
  assert.deepEqual([failedWake.sandbox_id, failedWake.codex_slot, failedWake.sandbox_snapshot], [null, null, "im-snap-w"]);
  const sbFailed = [...sandboxes.values()].find((s) => s.spec?.imageId === "im-snap-w")!;
  assert.ok(sbFailed.terminated, "the sandbox that could not log in is terminated");
  const marked = readSlotHealth(healthPath);
  assert.deepEqual(marked.map((m) => [m.slot, m.status]), [[slotA, "unusable"]], "the slot is marked unusable");
  assert.ok(!readFileSync(healthPath, "utf8").includes('"v"'), "the health file holds no login");
  const audit = await db.select().from(auditLog).where(eq(auditLog.job_id, failedWake.id));
  assert.deepEqual(audit.map((a) => [a.action, a.target, a.result]), [["sandbox_login_failed", slotA, "error"]], "the job's audit log says so");
  assert.deepEqual(usableSlots(limits).includes(slotA), false, "a marked slot is skipped");
  assert.deepEqual(sandboxReadiness({ codexSlots: [slotA, slotB, slotC] }, process.env, readSlotHealth(healthPath)).codexSlots, 2);
  assert.deepEqual(sandboxReadiness({ codexSlots: [slotA, slotB, slotC] }, process.env, readSlotHealth(healthPath)).codexSlotsUnusable, 1, "the inventory counts it");
  const image = { imageId: "im-secretish", t3Version: "0.1.3", factoryCommit: "abc1234", builtAt: "2026-10-26T10:00:00.000Z" };
  const reported = sandboxReadiness({ codexSlots: [], t3Version: "0.1.4", maxParallel: 3 }, process.env, [], image);
  assert.deepEqual(
    [reported.image, reported.imageInfo, reported.pinnedT3Version, reported.maxParallel],
    [true, { t3Version: "0.1.3", factoryCommit: "abc1234", builtAt: image.builtAt }, "0.1.4", 3],
    "the inventory reports the image's version, build time and commit, the pinned T3 and the cap",
  );
  assert.ok(!JSON.stringify(reported).includes("im-secretish"), "but not the image id");
  assert.deepEqual([sandboxReadiness({ codexSlots: [] }, process.env, [], null).image, sandboxReadiness({ codexSlots: [] }, process.env, [], null).imageInfo], [false, null]);
  const later = new Date(Date.now() + 60_000);
  utimesSync(join(slotA, "auth.json"), later, later);
  assert.ok(usableSlots(limits).includes(slotA), "a fresh login makes the slot usable again");
  codexOk = true;

  // A snapshot Modal no longer has: the thread is gone, and the slot is free again.
  const LOST = await insert("LOST", { stage: "waiting", t3_thread_id: "thread-LOST", sandbox_snapshot: "im-snap-missing" });
  assert.equal(await threads.state("thread-LOST", await ensureAwake(await row(LOST))), "gone");
  assert.equal((await row(LOST)).codex_slot, null);

  // Launch preflight: a slot whose login fails sends the job back to queued and is marked.
  const L = await insert("L", { stage: "queued", machine_id: null });
  const machine = { id: TEST_MACHINE_ID, repos: ["ski043/factory-demo"], maxInFlight: 1000 };
  const entry = (k: string) => ({ key: k, sandbox_id: null, attempt: 1, budgetUsd: 5, source: "linear" as const, repo: "ski043/factory-demo", branch: `factory/${k}`, threadTitle: k, message: `Work ${k}` });
  sandboxRuntime.slots = () => [slotC];
  codexOk = false;
  const [loginless] = await launchInSandboxes([entry(L)], machine, { provider: "codex", model: "gpt-6-astra" });
  assert.equal(loginless!.retry, "next pass", JSON.stringify(loginless));
  const l = await row(L);
  assert.deepEqual([l.stage, l.t3_thread_id, l.machine_id, l.sandbox_id, l.codex_slot], ["queued", null, null, null, null], "back to queued, holding nothing");
  assert.ok([...sandboxes.values()].filter((s) => s.spec?.tags.job === L).every((s) => s.terminated));
  assert.ok(readSlotHealth(healthPath).some((m) => m.slot === slotC), "the slot is marked");
  assert.deepEqual(await launchInSandboxes([entry(L)], machine, { provider: "codex", model: "gpt-6-astra" }), [], "and not leased again while its login is unchanged");
  codexOk = true;

  // Claude Code that the sandbox's claude refuses falls back to Codex, recorded on the job.
  sandboxRuntime.slots = () => [slotB, slotC];
  await db.update(jobs).set({ codex_slot: null }).where(eq(jobs.key, RUN));
  claudeToken = "sk-ant-oat-fake";
  claudeOk = false;
  const [fellBack] = await launchInSandboxes([entry(L)], machine, { provider: "claudeAgent", model: "claude-opus-5-5" });
  assert.equal(fellBack!.threadId, "thread-launched", JSON.stringify(fellBack));
  const lf = await row(L);
  assert.deepEqual([lf.provider, lf.model], ["codex", limits.codexModel]);
  const sbL = sandboxes.get(lf.sandbox_id!)!;
  assert.equal(JSON.parse(sbL.files.get("/root/.t3/userdata/settings.json")!).defaultModelSelection.instanceId, "codex");
  assert.ok(sbL.execs.some((e) => e.argv.join(" ").includes(`--provider codex --model ${limits.codexModel}`)));
  assert.ok(events.some((e) => e.event === "sandbox:harness-fallback" && e.detail.key === L));
  claudeOk = true;
  claudeToken = undefined;

  // Reaper: a sandbox no job points at, and a slot held with no sandbox running, go on the second sighting.
  const orphan = await sandboxFor(key("ORPHAN"));
  const foreign = await sandboxFor(key("FOREIGN"), "another-machine");
  const deadBox = await sandboxFor(key("DEAD"));
  await deadBox.terminate();
  const DEAD = await insert("DEAD", { stage: "pr", t3_thread_id: "thread-DEAD", sandbox_id: deadBox.sandboxId, codex_slot: slotC });
  const first = await reap();
  assert.deepEqual([first.terminated, first.freed], [[], []], "the first sighting only notes them");
  const second = await reap();
  assert.ok(second.terminated.includes(orphan.sandboxId) && orphan.terminated, JSON.stringify(second));
  assert.ok(!foreign.terminated && !second.terminated.includes(foreign.sandboxId), "another machine's sandbox is left alone");
  assert.ok(!sbRun.terminated && !sbL.terminated, "sandboxes jobs point at are left alone");
  assert.ok(second.freed.includes(`${DEAD}:${slotC}`), "the dead sandbox's slot is freed");
  const dead = await row(DEAD);
  assert.deepEqual([dead.codex_slot, dead.sandbox_id], [null, deadBox.sandboxId], "its sandbox id stays, so its thread reads as gone");
  assert.equal(await threads.state("thread-DEAD", hosts.forJob(dead)), "gone");

  // An answer to a hibernated job whose thread is gone once woken: the woken sandbox and its slot go, so it relaunches.
  const slotD = mkdtempSync(join(dir, "slot-d-"));
  writeFileSync(join(slotD, "auth.json"), `{"slot":"${slotD}","v":1}`, { mode: 0o600 });
  sandboxRuntime.slots = () => [slotD];
  const answered = new Set<string>();
  SOURCES.linear.replies = async (job) =>
    answered.has(job.key) ? { kind: "resume", question: "Which?", replies: [{ id: `reply-${job.key}`, body: "This one", createdAt: new Date().toISOString() }], answer: "This one" } : { kind: "wait" };
  fake.images.set("im-snap-r2", new Map());
  const R2 = await insert("R2", { stage: "waiting", question: "Which?", t3_thread_id: "thread-R2", session_id: "session-R2", sandbox_snapshot: "im-snap-r2" });
  archived.add("thread-R2");
  answered.add(R2);
  await assert.rejects(resumeAnswered(), /deployed ingest function/, "the queued event cannot post in a regression");
  const r2 = await row(R2);
  const sbR2 = [...sandboxes.values()].find((s) => s.spec?.imageId === "im-snap-r2")!;
  assert.ok(sbR2.terminated, "the woken sandbox ends");
  assert.deepEqual(
    [r2.sandbox_id, r2.sandbox_snapshot, r2.codex_slot, r2.t3_thread_id, r2.machine_id, r2.resume_context?.includes("This one")],
    [null, null, null, null, null, true],
    "it holds nothing and is unlinked with the Q&A kept",
  );
  assert.ok((await toLaunch()).some((e) => e.key === R2), "so it relaunches");
  answered.delete(R2);

  // An answer to a job whose sandbox timed out: its slot goes too, so it relaunches.
  const deadR1 = await sandboxFor(key("R1"));
  await deadR1.terminate();
  const R1 = await insert("R1", { stage: "waiting", question: "Which?", t3_thread_id: "thread-R1", session_id: "session-R1", sandbox_id: deadR1.sandboxId, codex_slot: slotD });
  answered.add(R1);
  await assert.rejects(resumeAnswered(), /deployed ingest function/);
  const r1 = await row(R1);
  assert.deepEqual([r1.sandbox_id, r1.codex_slot, r1.t3_thread_id, r1.machine_id], [null, null, null, null], JSON.stringify(r1));
  assert.ok((await toLaunch()).some((e) => e.key === R1), "so it relaunches");
  answered.clear();

  // Usage reconcile skips a run whose sandbox is gone and goes on with the rest.
  const sbUsage = await sandboxFor(key("UL"));
  const readPaths: string[] = [];
  const readText = sbUsage.filesystem.readText;
  sbUsage.filesystem = { ...sbUsage.filesystem, readText: async (path) => (readPaths.push(path), readText(path)) };
  sbUsage.files.set("/root/.claude/projects/x/session-UL.jsonl", "");
  const UG = await insert("UG", { stage: "implementing", sandbox_id: "sb-reconcile-gone" });
  const UL = await insert("UL", { stage: "implementing", sandbox_id: sbUsage.sandboxId });
  const runRow = (k: string, path: string) => ({ session_id: `session-${k}`, job_key: k, transcript_path: path, started_at: new Date(), last_event_at: new Date() });
  await db.insert(runs).values([runRow(UG, "/root/.claude/projects/x/session-UG.jsonl"), runRow(UL, "/root/.claude/projects/x/session-UL.jsonl")]);
  runKeys.push(UG, UL);
  assert.deepEqual(await reconcileUsage({ only: [UG, UL] }), [], "a gone sandbox does not abort the pass");
  assert.deepEqual(readPaths, ["/root/.claude/projects/x/session-UL.jsonl"], "the live run's transcript is still read");

  // A launch whose setup fails cleanly gives its room back, so the next job in the batch still launches.
  const [P1, P2] = [await insert("P1", { stage: "queued", machine_id: null }), await insert("P2", { stage: "queued", machine_id: null })];
  const maxParallel = limits.maxParallel;
  const githubToken = sandboxRuntime.githubToken;
  let tokenCalls = 0;
  sandboxRuntime.githubToken = async (repo) => {
    if (++tokenCalls === 1) throw new Error("GitHub is down");
    return githubToken(repo);
  };
  limits.maxParallel = (await sandboxesInFlight(TEST_MACHINE_ID)) + 1;
  try {
    const batch = await launchInSandboxes([entry(P1), entry(P2)], machine, { provider: "codex", model: "gpt-6-astra" });
    assert.deepEqual(batch.map((r) => [r.key, r.retry ?? r.threadId]), [[P1, "next pass"], [P2, "thread-launched"]], JSON.stringify(batch));
    assert.deepEqual([(await row(P1)).machine_id, (await row(P1)).codex_slot], [null, null], "the failed launch holds nothing");
  } finally {
    limits.maxParallel = maxParallel;
    sandboxRuntime.githubToken = githubToken;
  }

  // The timer's pass runs every step.
  const ticked = await tickSandboxes();
  assert.ok(!JSON.stringify(ticked).includes('"error'), JSON.stringify(ticked));

  console.log("lifecycle regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(auditLog).where(like(auditLog.job_id, "linear:lifecycle-regress-%"));
  if (runKeys.length > 0) await db.delete(runs).where(inArray(runs.job_key, runKeys));
  await db.delete(jobs).where(inArray(jobs.id, ids.map((id) => jobId("linear", id))));
  process.exit(process.exitCode ?? 0);
}
