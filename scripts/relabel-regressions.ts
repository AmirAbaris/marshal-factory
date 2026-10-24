import "./test-guard";
import assert from "node:assert/strict";

const { db } = await import("../db/client");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { factorySchema } = await import("../lib/config");

type Label = { id: string; name: string };
const states = ["Todo", "In Progress", "In Review", "Done"].map((name) => ({ id: `S:${name}`, name, type: "x" }));
const issueLabels = new Map<string, Label[]>();
const issueState = new Map<string, string>();
const label = (name: string): Label => ({ id: `label:${name}`, name });

const fakeClient = {
  team: async () => ({ id: "T1", states }),
  labelId: async (_teamId: string, name: string) => label(name).id,
  labelsOf: async (id: string) => issueLabels.get(id) ?? [],
  comment: async () => true,
  update: async (id: string, input: { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] }) => {
    const current = issueLabels.get(id) ?? [];
    for (const removed of input.removedLabelIds ?? []) {
      if (!current.some((l) => l.id === removed)) {
        throw new Error(`Label ${removed} is not on issue ${id} and cannot be removed`);
      }
    }
    const kept = current.filter((l) => !input.removedLabelIds?.includes(l.id));
    const added = (input.addedLabelIds ?? []).filter((a) => !kept.some((l) => l.id === a)).map((a) => label(a.slice("label:".length)));
    issueLabels.set(id, [...kept, ...added]);
    if (input.stateId) issueState.set(id, input.stateId);
  },
};
const adapter = createLinearAdapter(() => ({ client: fakeClient as never, db, limits: factorySchema.parse({}) }));
const names = (id: string) => (issueLabels.get(id) ?? []).map((l) => l.name).sort();
const job = (issueId: string, attempt: number, stage = "queued") =>
  ({
    id: `linear:${issueId}`,
    source: "linear",
    external_id: issueId,
    key: "REL-1",
    attempt,
    stage,
    stage_summary: "boom",
    writeback: { kind: "linear", issueId },
    source_state: { state: "Todo", labels: [], factoryCommentIds: [] },
  }) as never;

issueLabels.set("retry-cleared", [label("factory"), label("bug")]);
await adapter.announceClaim(job("retry-cleared", 2));
assert.deepEqual(names("retry-cleared"), ["bug", "factory"], "a retry claim succeeds when the human already removed factory-failed");
assert.equal(issueState.get("retry-cleared"), "S:In Progress", "and the issue moves to In Progress");

issueLabels.set("retry-kept", [label("factory"), { id: "workspace:ff", name: "Factory-Failed" }]);
await adapter.announceClaim(job("retry-kept", 2));
assert.deepEqual(names("retry-kept"), ["factory"], "a retry claim removes the factory-failed label the issue carries, whatever its id or case");

issueLabels.set("failed-unlabeled", [label("bug")]);
await adapter.writeBack(job("failed-unlabeled", 1, "failed"), { stage: "failed", eventId: "e-1" });
assert.deepEqual(names("failed-unlabeled"), ["bug", "factory-failed"], "writing back a failure succeeds when factory is already gone");
assert.equal(issueState.get("failed-unlabeled"), "S:Todo");

issueLabels.set("failed-replay", [label("factory-failed")]);
await adapter.writeBack(job("failed-replay", 1, "failed"), { stage: "failed", eventId: "e-2" });
assert.deepEqual(names("failed-replay"), ["factory-failed"], "a replayed failure write-back converges");

console.log("relabel regressions passed");
process.exit(0);
