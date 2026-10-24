import "./test-guard";
import assert from "node:assert/strict";
import { STAGES, type Stage } from "../lib/events";
import { canTransition, causeOf, decideStage, RUNNER_CAUSES, runnerEventId, type Cause } from "../lib/stages";
import { isStopped } from "../runner/binding";

const CAUSES: Cause[] = ["report", ...RUNNER_CAUSES];
const WORKING: Stage[] = ["queued", "triage", "investigating", "implementing", "verifying"];

const allowed: [Stage, Stage, Cause][] = [
  ["queued", "triage", "report"],
  ["triage", "investigating", "report"],
  ["triage", "implementing", "report"],
  ["triage", "waiting", "report"],
  ["triage", "failed", "report"],
  // Threads skip stages and repeat them: FAC-10 and FAC-7 went triage -> verifying, FAC-5 reported implementing twice.
  ["triage", "verifying", "report"],
  ["implementing", "implementing", "report"],
  ["investigating", "implementing", "report"],
  ["investigating", "waiting", "report"],
  ["implementing", "verifying", "report"],
  ["verifying", "implementing", "report"],
  ["verifying", "pr", "report"],
  ["pr", "pr", "report"],
  ["pr", "implementing", "conflict"],
  ["pr", "failed", "conflict"],
  ["pr", "merged", "merged"],
  ["pr", "failed", "stop"],
  ["waiting", "queued", "resume"],
  ["waiting", "failed", "closed"],
  ["waiting", "failed", "stop"],
  ["waiting", "triage", "report"],
  ["failed", "queued", "reclaim"],
  ["failed", "merged", "merged"],
  ...WORKING.flatMap((from): [Stage, Stage, Cause][] => [
    [from, "failed", "watchdog"],
    [from, "failed", "budget"],
    [from, "failed", "stop"],
    [from, "merged", "merged"],
  ]),
];
for (const [from, to, cause] of allowed) {
  assert.equal(canTransition(from, to, cause), true, `${from} -> ${to} (${cause}) is allowed`);
}

const forbidden: [Stage, Stage, Cause][] = [
  ...STAGES.flatMap((to) => CAUSES.map((cause): [Stage, Stage, Cause] => ["merged", to, cause])),
  ...STAGES.flatMap((to) => CAUSES.filter((c) => !(c === "reclaim" && to === "queued") && !(c === "merged" && to === "merged")).map((cause): [Stage, Stage, Cause] => ["failed", to, cause])),
  ...STAGES.flatMap((from): [Stage, Stage, Cause][] => [[from, "queued", "report"], [from, "merged", "report"]]),
  ...STAGES.filter((s) => s !== "failed").map((from): [Stage, Stage, Cause] => [from, "queued", "reclaim"]),
  ...STAGES.filter((s) => s !== "waiting").map((from): [Stage, Stage, Cause] => [from, "queued", "resume"]),
  ...STAGES.filter((s) => s !== "pr").map((from): [Stage, Stage, Cause] => [from, "implementing", "conflict"]),
  ["waiting", "failed", "watchdog"],
  ["waiting", "failed", "budget"],
  ["pr", "failed", "watchdog"],
  ["pr", "failed", "budget"],
  ["triage", "failed", "closed"],
  ["pr", "verifying", "conflict"],
];
for (const [from, to, cause] of forbidden) {
  assert.equal(canTransition(from, to, cause), false, `${from} -> ${to} (${cause}) is forbidden`);
}

for (const cause of RUNNER_CAUSES) {
  assert.equal(causeOf(runnerEventId(cause, "abc", 2, "x")), cause, `a ${cause} event id names its cause`);
}
assert.equal(causeOf("6e4900b4c22c2f3554c3955c41923e5ebe07a3ff"), "report", "a hook's hashed event id is a thread report");
assert.equal(causeOf("regress-1-7"), "report");
const stopped = { stage: "failed" as const, stage_event_id: runnerEventId("stop", "x", 1, "e"), t3_thread_id: null, stop_sent_to: null };
assert.equal(isStopped(stopped), true, "runner/binding.ts reads a stop from the prefix runnerEventId writes");

const row = { key: "FAC-7", stage: "implementing" as Stage, stage_at: new Date(1_000), attempt: 2, stage_event_id: "e-1" };
const move = (over: Partial<Parameters<typeof decideStage>[1]>) => decideStage(row, { stage: "verifying", at: new Date(2_000), eventId: "e-2", ...over });
assert.deepEqual(move({}), { apply: true, cause: "report" }, "a newer report on the current attempt applies");
assert.deepEqual(move({ branch: "factory/FAC-7-a2" }), { apply: true, cause: "report" });
assert.deepEqual(move({ at: new Date(1_000) }), { apply: true, cause: "report" }, "a report at the same instant still applies");
assert.deepEqual(move({ eventId: "e-1" }), { apply: false, cause: "report", reason: "already applied" }, "the runner's own write is not applied twice");
assert.deepEqual(move({ at: new Date(500) }), { apply: false, cause: "report", reason: "stale" });
assert.deepEqual(move({ branch: "factory/FAC-7" }), { apply: false, cause: "report", reason: "earlier attempt" });
assert.deepEqual(move({ stage: "merged" }), { apply: false, cause: "report", reason: "forbidden" }, "only the runner marks a job merged");
assert.deepEqual(
  decideStage({ ...row, stage: "failed" }, { stage: "pr", at: new Date(2_000), eventId: "e-3", branch: "factory/FAC-7-a2" }),
  { apply: false, cause: "report", reason: "forbidden" },
  "a stage after failed without a reclaim is refused",
);

console.log(`stages regressions passed: ${allowed.length} allowed and ${forbidden.length} forbidden transitions`);
