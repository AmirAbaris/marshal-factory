import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { fakeModal, type FakeSandbox } from "./fake-modal";
import type { JobHost } from "../lib/host";
import type { InterruptOutcome, SubagentThread } from "../lib/t3-client";
import type { ThreadActivity } from "../runner/threads";

const { db } = await import("../db/client");
const { jobs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { SOURCES } = await import("../lib/sources");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { modal } = await import("../lib/modal-host");
const { inboxKind, inboxReason } = await import("../lib/inbox");
const { parseStop } = await import("../lib/stop");
const { listSubagents, interruptThread } = await import("../lib/t3-client");
const { canReclaim, canReclaimSql, stopping } = await import("../runner/binding");
const { bindThread, ingestClient, machineInFlight, stopJob, threads, writeBack } = await import("../runner/ops");
const { confirmStops, retryStop } = await import("../runner/stops");
const { teardownFinished } = await import("../runner/lifecycle");

modal.api = fakeModal;

// --- fakes: the job's threads in T3, the source, ingest
const activity = new Map<string, ThreadActivity | Error>();
const subagents = new Map<string, SubagentThread[]>();
const interrupts: { threadId: string; requestId: string }[] = [];
let interruptAnswer: InterruptOutcome = { kind: "requested" };
const sent: string[] = [];
const running = (runId = "run-1"): ThreadActivity => ({ state: "running", activeRunId: runId, projectId: "proj-1" });
const idle: ThreadActivity = { state: "stopped", activeRunId: null, projectId: "proj-1" };
threads.activity = async (threadId) => {
  const a = activity.get(threadId!);
  if (a instanceof Error) throw a;
  return a ?? { state: "gone", activeRunId: null, projectId: null };
};
threads.subagents = async (threadId) => subagents.get(threadId) ?? [];
threads.interrupt = async (threadId, requestId) => (interrupts.push({ threadId, requestId }), interruptAnswer);
threads.state = async () => "running";
threads.send = async (threadId) => void sent.push(threadId);
ingestClient.post = async () => ({ refused: [] });
const reopened: string[] = [];
const written: string[] = [];
SOURCES.linear.confirmStop = async () => ({ stop: true, reopen: true });
SOURCES.linear.reopen = async (job) => void reopened.push(job.key);
SOURCES.linear.writeBack = async (job, { stage }) => (written.push(`${job.key}:${stage}`), true);

const stamp = Date.now() % 1_000_000;
const ids: string[] = [];
const key = (name: string) => `ST${name}-${stamp}`;
const row = async (k: string) => (await db.select().from(jobs).where(eq(jobs.key, k)))[0]!;
const stopOf = async (k: string) => parseStop((await row(k)).stop)!;
async function insert(name: string, over: Partial<typeof jobs.$inferInsert>) {
  const k = key(name);
  ids.push(`stop-regress-${k}`);
  await db.insert(jobs).values(linearJob(`stop-regress-${k}`, k, { machine_id: TEST_MACHINE_ID, stage: "implementing", stage_event_id: `e-${k}`, ...over }));
  return k;
}
const idOf = async (k: string) => (await row(k)).id;
const reclaimSql = async (k: string) =>
  (await db.select({ ok: sql<boolean>`${canReclaimSql}` }).from(jobs).where(eq(jobs.key, k)))[0]!.ok;
const S = 1000;

try {
  // --- the client: subagent threads come from T3's MCP endpoint, the token goes on stdin and the session is revoked
  {
    const calls: { command: string; args: string[]; input?: string }[] = [];
    const listing = [
      { threadId: "child", status: "running", latestRunId: "r-c", parentThreadId: "parent", relationshipToParent: "subagent" },
      { threadId: "grandchild", status: "completed", latestRunId: "r-g", parentThreadId: "child", relationshipToParent: "subagent" },
      { threadId: "fork", status: "running", latestRunId: "r-f", parentThreadId: "parent", relationshipToParent: "fork" },
      { threadId: "other", status: "running", latestRunId: "r-o", parentThreadId: "someone-else", relationshipToParent: "subagent" },
    ];
    const sandbox: JobHost = {
      t3: "t3",
      async run(command, args, options) {
        calls.push({ command, args, input: options?.input });
        if (args[0] === "auth" && args[2] === "issue") return { stdout: JSON.stringify({ sessionId: "sess-1", token: "secret-token" }), stderr: "" };
        if (args[0] === "auth" && args[2] === "revoke") return { stdout: "", stderr: "" };
        const { tool, args: toolArgs } = JSON.parse(options!.input!) as { tool: string; args: Record<string, unknown> };
        if (tool === "t3_thread_list") {
          // Children listed before their parent still count; two pages.
          const page = toolArgs.cursor === 0 ? [listing[1], listing[2]] : [listing[0], listing[3]];
          return { stdout: JSON.stringify({ structuredContent: { threads: page, nextCursor: toolArgs.cursor === 0 ? 2 : null } }), stderr: "" };
        }
        if (toolArgs.threadId === "full-access") {
          return { stdout: JSON.stringify({ isError: true, content: [{ type: "text", text: "Thread full-access now runs in full-access mode, above this caller's." }] }), stderr: "" };
        }
        return { stdout: JSON.stringify({ structuredContent: { threadId: toolArgs.threadId, runId: "r", status: "interrupt_requested" } }), stderr: "" };
      },
      readFile: async (path) => (path === "/root/.t3/userdata/server-runtime.json" ? JSON.stringify({ origin: "http://127.0.0.1:3773" }) : null),
      writeFile: async () => {},
      exists: async () => true,
      list: async () => [],
      mtimeMs: async () => 0,
      remove: async () => {},
    };
    const found = await listSubagents(sandbox, "parent", "proj-1");
    assert.deepEqual(found.map((t) => t.threadId).sort(), ["child", "grandchild"], "every subagent below the thread, and nothing else");
    assert.deepEqual(await interruptThread(sandbox, "t-1", "req-1", "stop"), { kind: "requested" });
    const refused = await interruptThread(sandbox, "full-access", "req-2", "stop");
    assert.equal(refused.kind, "refused", "T3's refusal is an outcome, not an error");
    assert.ok(calls.every((c) => !c.args.join(" ").includes("secret-token")), "the token never goes into argv");
    const scripts = calls.filter((c) => c.command === "node");
    assert.ok(scripts.length >= 4 && scripts.every((c) => c.input?.includes("secret-token") && c.input.includes("http://127.0.0.1:3773")), "in a sandbox the call runs there with node, token on stdin");
    const issues = calls.filter((c) => c.args[2] === "issue");
    assert.deepEqual(issues[0]!.args.filter((a, i) => issues[0]!.args[i - 1] === "--scope"), ["orchestration:read"], "a read signs in read-only");
    assert.ok(issues.every((c) => c.args.includes("--ttl") && c.args[c.args.indexOf("--ttl") + 1] === "5m"), "short-lived sessions");
    assert.equal(calls.filter((c) => c.args[2] === "revoke").length, issues.length, "every session is revoked after use");
  }

  // --- a polite stop the thread obeys: confirmed once it stays quiet for the settle time
  const A = await insert("A", { t3_thread_id: "thread-A" });
  activity.set("thread-A", running());
  const inFlightBefore = await machineInFlight(TEST_MACHINE_ID);
  assert.equal(await stopJob(await idOf(A), "the factory label was removed"), "stopped");
  let t0 = Date.now();
  let a = await row(A);
  assert.equal(a.stage, "failed");
  assert.deepEqual([parseStop(a.stop)!.state, parseStop(a.stop)!.how, a.stop_sent_to], ["delivered", "message", "thread-A"], "the message went out and is recorded");
  assert.ok(stopping(a), "a stop on its way keeps the job stopping");
  assert.equal(await machineInFlight(TEST_MACHINE_ID), inFlightBefore, "it keeps its capacity until confirmed");
  assert.equal(canReclaim(a), false);
  assert.equal(await reclaimSql(A), false, "the SQL rule agrees");
  assert.equal(reopened.length, 0, "the source hears nothing yet");
  activity.set("thread-A", idle);
  await confirmStops({ only: [a.id], now: t0 + 20 * S });
  assert.ok((await stopOf(A)).quietSince, "quiet is noted");
  assert.equal((await stopOf(A)).state, "delivered", "one quiet look is not enough");
  await confirmStops({ only: [a.id], now: t0 + 55 * S });
  a = await row(A);
  assert.equal(parseStop(a.stop)!.state, "confirmed");
  assert.match(parseStop(a.stop)!.evidence!, /no active run for 35 s, and it has no subagent threads/);
  assert.deepEqual(reopened, [A], "the source is reopened once the stop is confirmed");
  assert.equal(await machineInFlight(TEST_MACHINE_ID), inFlightBefore - 1, "a confirmed stop frees the capacity");
  assert.equal(canReclaim(a), true);
  assert.equal(await reclaimSql(A), true);
  assert.equal(interrupts.length, 0, "an obeyed stop is never interrupted");
  // Replays: a second stop intent and more ticks change nothing.
  assert.equal(await stopJob(a.id, "the factory label was removed"), "stopped");
  await confirmStops({ only: [a.id], now: t0 + 400 * S });
  assert.deepEqual([sent.filter((s) => s === "thread-A").length, reopened.length, (await stopOf(A)).state], [1, 1, "confirmed"], "idempotent across replays");
  assert.deepEqual(inboxKind(await row(A)), "failed", "a stopped job shows as failed, as before");

  // --- still running after the grace: interrupt the thread and its running subagents, then wait for both
  const B = await insert("B", { t3_thread_id: "thread-B" });
  activity.set("thread-B", running("run-B"));
  subagents.set("thread-B", [
    { threadId: "sub-B1", status: "running", latestRunId: "run-B1" },
    { threadId: "sub-B2", status: "completed", latestRunId: "run-B2" },
  ]);
  activity.set("thread-unrelated", running());
  await stopJob(await idOf(B), "the issue was canceled");
  t0 = Date.now();
  const b = await idOf(B);
  await confirmStops({ only: [b], now: t0 + 30 * S });
  assert.equal(interrupts.length, 0, "not before interruptAfter");
  assert.match((await stopOf(B)).step!, /still run/);
  await confirmStops({ only: [b], now: t0 + 70 * S });
  assert.deepEqual(interrupts.map((i) => i.threadId), ["thread-B", "sub-B1"], "the thread and its running subagent, nothing else");
  assert.ok(interrupts[0]!.requestId.includes("run-B") && interrupts[1]!.requestId.includes("run-B1"), "one request id per run");
  assert.deepEqual([(await stopOf(B)).state, (await stopOf(B)).how], ["escalated", "interrupt"]);
  await confirmStops({ only: [b], now: t0 + 75 * S });
  assert.equal(interrupts.length, 2, "checks closer than checkSeconds don't ask again");
  activity.set("thread-B", idle);
  await confirmStops({ only: [b], now: t0 + 95 * S });
  assert.deepEqual(interrupts.slice(2).map((i) => i.threadId), ["sub-B1"], "a subagent still running is interrupted again; the parent alone isn't enough");
  assert.equal((await stopOf(B)).quietSince, null, "a running subagent keeps the stop from settling");
  subagents.set("thread-B", [
    { threadId: "sub-B1", status: "interrupted", latestRunId: "run-B1" },
    { threadId: "sub-B2", status: "completed", latestRunId: "run-B2" },
  ]);
  await confirmStops({ only: [b], now: t0 + 115 * S });
  await confirmStops({ only: [b], now: t0 + 150 * S });
  assert.equal((await stopOf(B)).state, "confirmed");
  assert.match((await stopOf(B)).evidence!, /its 2 subagent threads have settled/);
  assert.ok(!interrupts.some((i) => i.threadId === "thread-unrelated"), "other threads are never touched");

  // --- T3 refuses the interrupt and the thread keeps going: unconfirmed, in the inbox, holding off a retry
  const D = await insert("D", { t3_thread_id: "thread-D" });
  activity.set("thread-D", running("run-D"));
  interruptAnswer = { kind: "refused", reason: "Thread thread-D now runs in full-access mode, above this caller's." };
  await stopJob(await idOf(D), "the factory label was removed");
  t0 = Date.now();
  const d = await idOf(D);
  await confirmStops({ only: [d], now: t0 + 70 * S });
  assert.match((await stopOf(D)).step!, /^T3 refused to interrupt thread-D: Thread thread-D now runs in full-access mode/);
  await confirmStops({ only: [d], now: t0 + 301 * S });
  let dRow = await row(D);
  assert.equal(parseStop(dRow.stop)!.state, "unconfirmed");
  assert.match(parseStop(dRow.stop)!.evidence!, /^The thread still runs 5 min after the stop\. T3 refused to interrupt/);
  assert.equal(inboxKind(dRow), "stop_unconfirmed", "the owner gets an inbox item");
  assert.match(inboxReason({ kind: "stop_unconfirmed", job: dRow, decision: null, at: new Date() }), /still runs 5 min/);
  assert.ok(reopened.includes(D), "an unconfirmed stop settles: the source hears about it");
  assert.equal(stopping(dRow), false, "and the capacity is free");
  assert.deepEqual([canReclaim(dRow), await reclaimSql(D)], [false, false], "but no new attempt while the old thread may run");
  // Retry stop interrupts again at once; once the thread settles it is confirmed.
  interruptAnswer = { kind: "requested" };
  const before = interrupts.length;
  assert.deepEqual(await retryStop(d, t0 + 320 * S), { retried: D });
  assert.equal(interrupts.length, before + 1, "the retry interrupts at once");
  const firstRound = interrupts.slice(0, before).filter((i) => i.threadId === "thread-D").map((i) => i.requestId);
  assert.ok(firstRound.length > 0 && new Set(firstRound).size === 1, "within one round the request id repeats, so T3 ignores the repeat");
  assert.ok(!firstRound.includes(interrupts[before]!.requestId), "the retry is a new request id, so T3 does not take it for a repeat");
  assert.deepEqual([(await stopOf(D)).state, (await stopOf(D)).retries], ["escalated", 1]);
  assert.deepEqual(await retryStop(d, t0 + 321 * S), { refused: "The stop is not waiting on you." }, "a retry is only offered for an unconfirmed stop");
  activity.set("thread-D", idle);
  await confirmStops({ only: [d], now: t0 + 340 * S });
  await confirmStops({ only: [d], now: t0 + 380 * S });
  dRow = await row(D);
  assert.equal(parseStop(dRow.stop)!.state, "confirmed");
  assert.equal(reopened.filter((k) => k === D).length, 1, "the source is reopened once");
  assert.notEqual(inboxKind(dRow), "stop_unconfirmed");

  // --- an unconfirmed stop the owner dismisses lets the label retry the job
  const U = await insert("U", { t3_thread_id: "thread-U" });
  activity.set("thread-U", new Error("T3 did not answer"));
  await stopJob(await idOf(U), "the factory label was removed");
  t0 = Date.now();
  await confirmStops({ only: [await idOf(U)], now: t0 + 30 * S });
  assert.match((await stopOf(U)).step!, /^Could not read the thread: T3 did not answer/);
  await confirmStops({ only: [await idOf(U)], now: t0 + 310 * S });
  assert.equal((await stopOf(U)).state, "unconfirmed", "a thread that can't be read is never taken as stopped");
  await db.update(jobs).set({ dismissed_at: new Date(t0 + 400 * S) }).where(eq(jobs.key, U));
  const uRow = await row(U);
  assert.deepEqual([inboxKind(uRow), canReclaim(uRow), await reclaimSql(U)], [null, true, true], "dismissed: out of the inbox, and a retry may start");

  // --- a stop recorded while the launch is pending reaches the thread once it is bound
  const P = await insert("P", { t3_thread_id: "pending:launch-P" });
  await stopJob(await idOf(P), "the factory label was removed");
  assert.equal((await stopOf(P)).state, "requested", "nothing to deliver to yet");
  activity.set("thread-P", running());
  await bindThread(P, "thread-P");
  assert.deepEqual([(await stopOf(P)).state, (await stopOf(P)).thread], ["delivered", "thread-P"]);

  // --- a job that never got a thread: confirmed at once
  const N = await insert("N", { stage: "queued", machine_id: null, t3_thread_id: null });
  await stopJob(await idOf(N), "the factory label was removed");
  assert.deepEqual([(await stopOf(N)).state, (await stopOf(N)).evidence], ["confirmed", "No thread was started, so nothing ran."]);

  // --- write-back waits for the stop to settle
  const W = await insert("W", {
    stage: "failed",
    stage_event_id: `stop:W-${stamp}`,
    stop_event_id: `stop:W-${stamp}`,
    t3_thread_id: "thread-W",
    stop_sent_to: "thread-W",
    stop: { ...(await stopOf(B)), state: "delivered", reopen: false, thread: "thread-W", checkedAt: null, quietSince: null, settledAt: null, evidence: null },
  });
  await writeBack();
  assert.ok(!written.some((w) => w.startsWith(W)), "no write-back while stopping");
  activity.set("thread-W", { state: "gone", activeRunId: null, projectId: null });
  await confirmStops({ only: [await idOf(W)] });
  assert.equal((await stopOf(W)).state, "confirmed", "a thread T3 no longer has is stopped");
  await writeBack();
  assert.ok(written.includes(`${W}:failed`), "written back once settled");

  // --- Modal: ending the sandbox confirms the stop, once Modal no longer answers for it
  const M = await insert("M", { t3_thread_id: "thread-M", execution: "modal" });
  const sbM = (await fakeModal.create({ name: `job-${M}`, tags: { job: M }, imageId: "im-test", secrets: {}, env: {}, encryptedPorts: [], limits: { appName: "x", cpu: 1, cpuLimit: 1, memoryMiB: 1, memoryLimitMiB: 1, timeoutMs: 1 } })) as FakeSandbox;
  const sbStuck = (await fakeModal.create({ name: `job-${M}-stuck`, tags: { job: M }, imageId: "im-test", secrets: {}, env: {}, encryptedPorts: [], limits: { appName: "x", cpu: 1, cpuLimit: 1, memoryMiB: 1, memoryLimitMiB: 1, timeoutMs: 1 } })) as FakeSandbox;
  sbStuck.terminate = async () => {};
  const K = await insert("K", { t3_thread_id: "thread-K", execution: "modal", sandbox_id: sbStuck.sandboxId });
  await db.update(jobs).set({ sandbox_id: sbM.sandboxId }).where(eq(jobs.key, M));
  await stopJob(await idOf(M), "the factory label was removed");
  await stopJob(await idOf(K), "the factory label was removed");
  assert.equal((await stopOf(M)).state, "delivered", "the sandbox still runs");
  await teardownFinished();
  assert.equal(sbM.terminated, true);
  const m = await row(M);
  assert.deepEqual([m.sandbox_id, parseStop(m.stop)!.how], [null, "terminate"]);
  assert.equal((await row(K)).sandbox_id, sbStuck.sandboxId, "a sandbox that still answers keeps its row, and teardown tries again");
  await confirmStops({ only: [m.id, await idOf(K)] });
  assert.deepEqual([(await stopOf(M)).state, (await stopOf(M)).evidence], ["confirmed", `Ended sandbox ${sbM.sandboxId}; Modal no longer runs it.`]);
  assert.equal((await stopOf(K)).state, "delivered", "not confirmed while Modal still answers");
  assert.equal(interrupts.filter((i) => i.threadId === "thread-M").length, 0, "a sandbox is ended, not interrupted");

  console.log("stop regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(inArray(jobs.id, ids.map((id) => jobId("linear", id))));
  process.exit(process.exitCode ?? 0);
}
