import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { githubIntent, linearIntent, verifyGithub, verifyLinear } from "../lib/webhooks";

const secret = "s3cret";
const sign = (body: string) => createHmac("sha256", secret).update(body).digest("hex");
const now = 1_800_000_000_000;

const linearBody = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: now - 5_000, data: {} });
assert.deepEqual(verifyLinear(linearBody, sign(linearBody), secret, now), { ok: true });
assert.equal(verifyLinear(linearBody, sign(linearBody + " "), secret, now).ok, false, "a wrong signature is rejected");
assert.equal(verifyLinear(linearBody, null, secret, now).ok, false, "a missing signature is rejected");
const old = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: now - 61_000, data: {} });
assert.deepEqual(verifyLinear(old, sign(old), secret, now), { ok: false, reason: "stale webhookTimestamp" }, "a replay older than a minute is rejected");
assert.equal(verifyGithub("{}", `sha256=${sign("{}")}`, secret).ok, true);
assert.equal(verifyGithub("{}", sign("{}"), secret).ok, false, "GitHub signatures need the sha256= prefix");

const opts = { teamKey: "FAC", label: "factory" };
const issue = (over: Record<string, unknown> = {}, updatedFrom?: Record<string, unknown>) => ({
  action: "update",
  type: "Issue",
  updatedFrom,
  data: {
    id: "i1",
    identifier: "FAC-11",
    team: { key: "FAC" },
    labels: [{ id: "l1", name: "factory" }],
    labelIds: ["l1"],
    state: { type: "unstarted", name: "Todo" },
    ...over,
  },
});
assert.deepEqual(linearIntent(issue({}, { labelIds: [] }), opts), { kind: "claim", issueKey: "FAC-11", linearId: "i1" }, "labeled in Todo means claim");
assert.equal(linearIntent(issue({ state: { type: "started", name: "In Progress" } }), opts), null, "a started issue is not claimed again");
assert.equal(linearIntent(issue({ identifier: "ALE-3", team: { key: "ALE" } }), opts), null, "other teams are ignored");
assert.equal(linearIntent(issue({ labels: [], labelIds: [] }, { labelIds: ["l1"] }), opts)?.kind, "stop", "removing the label stops");
assert.equal(
  linearIntent(issue({ labels: [{ id: "l2", name: "bug" }], labelIds: ["l2"] }, { labelIds: ["l1"] }), opts)?.kind,
  "stop",
  "swapping factory for another label in one edit stops too",
);
assert.equal(
  linearIntent(issue({ state: { type: "canceled", name: "Canceled" } }, { stateId: "x" }), opts)?.kind,
  "stop",
  "canceling stops",
);
assert.deepEqual(
  linearIntent({ action: "create", type: "Comment", data: { id: "c1", issueId: "i1", body: "1: (b)" } }, opts),
  { kind: "answer", linearId: "i1" },
);

assert.deepEqual(
  githubIntent("pull_request", { action: "closed", pull_request: { html_url: "https://g/p/1", merged: true } }),
  { kind: "merged", prUrl: "https://g/p/1" },
);
assert.equal(githubIntent("pull_request", { action: "closed", pull_request: { html_url: "u", merged: false } }), null, "a closed, unmerged PR is not a merge");
assert.equal(githubIntent("push", { ref: "refs/heads/main", repository: { default_branch: "main" } })?.kind, "recheck_conflicts");
assert.equal(githubIntent("push", { ref: "refs/heads/factory/FAC-1", repository: { default_branch: "main" } }), null);
assert.equal(githubIntent("ping", {}), null);
console.log("webhook regressions passed");
