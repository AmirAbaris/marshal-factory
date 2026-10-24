import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { readAppFile } from "../lib/github/app";

// Exercises the deployed webhook routes: a signed GitHub merge for a throwaway non-factory PR,
// its replay, and bad signatures on both routes.
process.loadEnvFile(".env.local");
const base = process.env.NEON_FUNCTION_INGEST_BASE_URL!.replace(/\/$/, "");
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

async function github(body: object, delivery: string, signature?: string) {
  const raw = JSON.stringify(body);
  const res = await fetch(`${base}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": delivery,
      "x-hub-signature-256": signature ?? `sha256=${sign(process.env.GITHUB_APP_WEBHOOK_SECRET || readAppFile().webhook_secret, raw)}`,
    },
    body: raw,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const merged = {
  action: "closed",
  pull_request: { html_url: `https://github.com/ski043/factory-demo/pull/0-smoke-${Date.now()}`, merged: true },
};
const delivery = randomUUID();
const first = await github(merged, delivery);
console.log("signed merge:", first.status, JSON.stringify(first.body));
assert.deepEqual([first.status, first.body.intent], [200, "merged"]);
const replay = await github(merged, delivery);
console.log("replayed delivery:", replay.status, JSON.stringify(replay.body));
assert.deepEqual([replay.status, replay.body.duplicate, replay.body.intent], [200, true, null]);
const forged = await github(merged, randomUUID(), "sha256=" + "0".repeat(64));
console.log("bad GitHub signature:", forged.status);
assert.equal(forged.status, 401);

const linearBody = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: Date.now(), data: {} });
const badLinear = await fetch(`${base}/webhooks/linear`, {
  method: "POST",
  headers: { "content-type": "application/json", "linear-delivery": randomUUID(), "linear-signature": "0".repeat(64) },
  body: linearBody,
});
console.log("bad Linear signature:", badLinear.status);
assert.equal(badLinear.status, 401);
const oldBody = JSON.stringify({ action: "update", type: "Issue", webhookTimestamp: Date.now() - 120_000, data: {} });
const stale = await fetch(`${base}/webhooks/linear`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "linear-delivery": randomUUID(),
    "linear-signature": sign(process.env.LINEAR_WEBHOOK_SECRET!, oldBody),
  },
  body: oldBody,
});
console.log("stale Linear timestamp:", stale.status, await stale.text());
assert.equal(stale.status, 401);
console.log(`webhook smoke passed; delivery github:${delivery}`);
