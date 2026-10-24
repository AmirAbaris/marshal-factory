import "./test-guard";
import assert from "node:assert/strict";
import { asc } from "drizzle-orm";

const { db } = await import("../db/client");
const { issues } = await import("../db/schema");
const ops = await import("../runner/ops");
const { SOURCES } = await import("../lib/sources");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { factorySchema } = await import("../lib/config");

const calls: unknown[] = [];
const record = <T>(name: string, result: T) => (...args: unknown[]) => {
  calls.push([name, ...args]);
  return Promise.resolve(result);
};
const team = { id: "T1", states: ["Todo", "In Progress", "In Review", "Done"].map((name) => ({ id: `S:${name}`, name, type: "x" })) };
const node = (id: string, identifier: string) => ({
  id,
  identifier,
  title: `title ${identifier}`,
  url: `https://linear.app/${identifier}`,
  description: "d",
  createdAt: "2026-10-24T00:00:00Z",
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "factory" }, { name: "bug" }] },
});
let readyNodes: ReturnType<typeof node>[] = [];
let thread = { state: { name: "In Progress", type: "started" }, labels: ["factory"] };
const labelsById: Record<string, string[]> = { "src-q2": ["factory", "factory-failed"] };
const fakeClient = {
  team: record("team", team),
  update: record("update", undefined),
  comment: record("comment", true),
  labelId: (teamId: string, name: string) => {
    calls.push(["labelId", teamId, name]);
    return Promise.resolve(`label:${name}`);
  },
  readyIssues: (...args: unknown[]) => {
    calls.push(["readyIssues", ...args]);
    return Promise.resolve(readyNodes);
  },
  issueWithComments: (id: string) => {
    calls.push(["issueWithComments", id]);
    return Promise.resolve({ state: thread.state, comments: [] });
  },
  labelsOf: (id: string) => {
    calls.push(["labelsOf", id]);
    return Promise.resolve((labelsById[id] ?? thread.labels).map((name) => ({ id: `label:${name}`, name })));
  },
  setState: record("setState", undefined),
};
SOURCES.linear = createLinearAdapter(() => ({ client: fakeClient as never, db, limits: factorySchema.parse({}) }));

const EXPECTED = {
  "writes": {
    "synced": [
      "SRC-1:pr",
      "SRC-2:waiting",
      "SRC-3:failed",
      "SRC-4:merged"
    ],
    "calls": [
      [
        "team",
        "FAC"
      ],
      [
        "update",
        "src-pr",
        {
          "stateId": "S:In Review"
        }
      ],
      [
        "comment",
        "src-pr",
        "368968ca-5f44-4b9f-8953-4b89e8bcd24c",
        "marshal-factory has a pull request ready for review: https://g/pr/1\n\ndone"
      ],
      [
        "comment",
        "src-wait",
        "4ac8711f-b5ac-4093-b778-86a8e21f9bab",
        "marshal-factory stopped and needs an answer before it can continue:\n\nWhich layout?"
      ],
      [
        "labelsOf",
        "src-fail"
      ],
      [
        "labelId",
        "T1",
        "factory-failed"
      ],
      [
        "update",
        "src-fail",
        {
          "stateId": "S:Todo",
          "addedLabelIds": [
            "label:factory-failed"
          ],
          "removedLabelIds": [
            "label:factory"
          ]
        }
      ],
      [
        "comment",
        "src-fail",
        "b1e0641a-e8ae-43b6-a329-344171e78538",
        "marshal-factory gave up on this issue (attempt 2): boom\n\nAdd the `factory` label again to retry."
      ],
      [
        "update",
        "src-merged",
        {
          "stateId": "S:Done"
        }
      ],
      [
        "update",
        "src-q1",
        {
          "stateId": "S:In Progress"
        }
      ],
      [
        "comment",
        "src-q1",
        "e859071b-d221-4990-bacb-cdf002be4667",
        "Picked up by marshal-factory."
      ],
      [
        "labelsOf",
        "src-q2"
      ],
      [
        "update",
        "src-q2",
        {
          "stateId": "S:In Progress",
          "addedLabelIds": [],
          "removedLabelIds": [
            "label:factory-failed"
          ]
        }
      ],
      [
        "comment",
        "src-q2",
        "fbadf7f5-f936-4d2c-ab88-0d811cc8d183",
        "Picked up by marshal-factory again (attempt 2, branch factory/SRC-7-a2)."
      ]
    ],
    "rows": [
      {
        "key": "SRC-1",
        "stage": "pr",
        "attempt": 1,
        "linear_state": "In Review",
        "synced_event_id": "e-pr",
        "labels": [],
        "previous_failure": null,
        "comments": 1
      },
      {
        "key": "SRC-2",
        "stage": "waiting",
        "attempt": 1,
        "linear_state": null,
        "synced_event_id": "e-wait",
        "labels": [],
        "previous_failure": null,
        "comments": 1
      },
      {
        "key": "SRC-3",
        "stage": "failed",
        "attempt": 2,
        "linear_state": "Todo",
        "synced_event_id": "e-fail",
        "labels": [],
        "previous_failure": null,
        "comments": 1
      },
      {
        "key": "SRC-4",
        "stage": "merged",
        "attempt": 1,
        "linear_state": "Done",
        "synced_event_id": "e-merged",
        "labels": [],
        "previous_failure": null,
        "comments": 0
      },
      {
        "key": "SRC-5",
        "stage": "triage",
        "attempt": 1,
        "linear_state": null,
        "synced_event_id": "e-triage",
        "labels": [],
        "previous_failure": null,
        "comments": 0
      },
      {
        "key": "SRC-6",
        "stage": "queued",
        "attempt": 1,
        "linear_state": "In Progress",
        "synced_event_id": null,
        "labels": [],
        "previous_failure": null,
        "comments": 1
      },
      {
        "key": "SRC-7",
        "stage": "queued",
        "attempt": 2,
        "linear_state": "In Progress",
        "synced_event_id": null,
        "labels": [],
        "previous_failure": null,
        "comments": 1
      }
    ]
  },
  "claim": {
    "claimed": {
      "claimed": [
        "SRC-8",
        "SRC-9"
      ],
      "inFlight": 2
    },
    "calls": [
      [
        "readyIssues",
        "FAC",
        "factory"
      ]
    ],
    "rows": [
      {
        "key": "SRC-8",
        "stage": "queued",
        "attempt": 1,
        "linear_state": "Todo",
        "synced_event_id": null,
        "labels": [
          "factory",
          "bug"
        ],
        "previous_failure": null,
        "comments": 0
      },
      {
        "key": "SRC-9",
        "stage": "queued",
        "attempt": 2,
        "linear_state": "Todo",
        "synced_event_id": null,
        "labels": [
          "factory",
          "bug"
        ],
        "previous_failure": "earlier failure",
        "comments": 0
      }
    ]
  },
  "stopCheck": {
    "stillLabeled": "still labeled",
    "calls": [
      [
        "issueWithComments",
        "src-new"
      ],
      [
        "labelsOf",
        "src-new"
      ]
    ]
  },
  "confirm": {
    "unlabeled": {
      "stop": true,
      "reopen": true
    },
    "canceled": {
      "stop": true,
      "reopen": false
    },
    "deleted": {
      "stop": true,
      "reopen": false
    },
    "calls": [
      [
        "issueWithComments",
        "src-new"
      ],
      [
        "labelsOf",
        "src-new"
      ],
      [
        "issueWithComments",
        "src-new"
      ],
      [
        "labelsOf",
        "src-new"
      ],
      [
        "setState",
        "src-new",
        "S:Todo"
      ]
    ]
  }
};

const now = new Date();
const base = { title: "t", url: "u", claimed_at: now, updated_at: now };
const snapshot = async () =>
  (await db.select().from(issues).orderBy(asc(issues.key))).map((i) => ({
    key: i.key,
    stage: i.stage,
    attempt: i.attempt,
    linear_state: i.linear_state,
    synced_event_id: i.synced_event_id,
    labels: i.labels,
    previous_failure: i.previous_failure,
    comments: i.factory_comment_ids.length,
  }));

try {
  await db.delete(issues);
  await db.insert(issues).values([
    { ...base, linear_id: "src-pr", key: "SRC-1", stage: "pr", stage_event_id: "e-pr", pr_url: "https://g/pr/1", stage_summary: "done" },
    { ...base, linear_id: "src-wait", key: "SRC-2", stage: "waiting", stage_event_id: "e-wait", question: "Which layout?" },
    { ...base, linear_id: "src-fail", key: "SRC-3", stage: "failed", attempt: 2, stage_event_id: "e-fail", stage_summary: "boom" },
    { ...base, linear_id: "src-merged", key: "SRC-4", stage: "merged", stage_event_id: "e-merged" },
    { ...base, linear_id: "src-triage", key: "SRC-5", stage: "triage", stage_event_id: "e-triage" },
    { ...base, linear_id: "src-q1", key: "SRC-6", stage: "queued", linear_state: "Todo" },
    { ...base, linear_id: "src-q2", key: "SRC-7", stage: "queued", attempt: 2, linear_state: "Todo" },
  ]);
  const synced = await ops.writeBack();
  await ops.announceClaims();
  const writes = { synced, calls: structuredClone(calls), rows: await snapshot() };
  calls.length = 0;
  assert.deepEqual(
    await ops.writeBack(),
    [],
    "a second pass writes nothing back",
  );
  assert.deepEqual(calls, [], "and sends nothing to Linear");

  await db.delete(issues);
  await db.insert(issues).values({ ...base, linear_id: "src-retry", key: "SRC-9", stage: "failed", stage_summary: "earlier failure", stage_event_id: "e-r", synced_event_id: "e-r" });
  readyNodes = [node("src-new", "SRC-8"), node("src-retry", "SRC-9")];
  calls.length = 0;
  const claimed = await ops.claim();
  const claim = { claimed, calls: structuredClone(calls), rows: await snapshot() };

  calls.length = 0;
  const stillLabeled = await ops.stopIssue("src-new", "the factory label was removed in Linear");
  const stopCheck = { stillLabeled, calls: structuredClone(calls) };

  calls.length = 0;
  const adapter = SOURCES.linear;
  thread = { state: { name: "In Progress", type: "started" }, labels: [] };
  const unlabeled = await adapter.confirmStop("src-new", "the factory label was removed in Linear");
  thread = { state: { name: "Canceled", type: "canceled" }, labels: ["Factory"] };
  const canceled = await adapter.confirmStop("src-new", "issue moved to Canceled in Linear");
  const deleted = await adapter.confirmStop("src-new", "the issue was deleted in Linear");
  await adapter.reopen({ linear_id: "src-new" } as never);
  const confirm = { unlabeled, canceled, deleted, calls: structuredClone(calls) };

  assert.deepEqual({ writes, claim, stopCheck, confirm }, EXPECTED);
  console.log("source regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(issues);
  process.exit(process.exitCode ?? 0);
}
