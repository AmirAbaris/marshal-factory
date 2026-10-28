import "./test-guard";
import assert from "node:assert/strict";
import { jobsHref } from "../components/panel/job-view";
import { activityHref, fullViewHref, parseSessionId, runFeedPath } from "../lib/run-links";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);
process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";
delete process.env.NEON_REALTIME_SECRET;

const CODEX = "mcp:factory/FAC-61";
for (const id of [CODEX, "mcp:factory/FAC-10-a2", "evidence:factory/FAC-10-a2", "5f0c1e2a-9b7d-4c3e-8a1f-2d6b7c8e9f01", "mcp:factory/FAC-7"]) {
  assert.equal(parseSessionId(id), id, `${id} is a session id`);
}
for (const junk of [undefined, null, "", "/", "mcp:factory/", "/mcp:factory", "mcp:factory//FAC-1", "a b", "a?b", "a#b", "a&b=c", "x".repeat(129)]) {
  assert.equal(parseSessionId(junk), undefined, `${JSON.stringify(junk)} is not a session id`);
}

assert.equal(activityHref(CODEX), "/activity?run=mcp%3Afactory%2FFAC-61");
assert.equal(new URL(activityHref(CODEX), "http://x").searchParams.get("run"), CODEX, "the activity link round-trips the id");
assert.equal(new URL(jobsHref("list", CODEX), "http://x").searchParams.get("run"), CODEX, "the jobs link round-trips the id");
const opened = new URL(jobsHref("board", CODEX), "http://x");
const full = new URL(fullViewHref(opened.pathname, opened.searchParams, true), "http://x");
assert.equal(full.searchParams.get("full"), "1", "full view is a search param");
assert.equal(full.searchParams.get("run"), CODEX, "full view keeps the open run");
assert.equal(full.searchParams.get("view"), "board", "full view keeps the jobs layout");
const back = new URL(fullViewHref(full.pathname, full.searchParams, false), "http://x");
assert.equal(back.searchParams.has("full"), false, "the side panel drops the param");
assert.equal(back.searchParams.get("run"), CODEX, "the side panel keeps the open run");
assert.equal(fullViewHref("/inbox", new URLSearchParams({ job: "FAC-1" }), true), "/inbox?job=FAC-1&full=1");
assert.equal(fullViewHref("/inbox", new URLSearchParams({ full: "1" }), false), "/inbox", "no empty query is left behind");
for (const feed of ["agents", "events", "stages"] as const) {
  const url = new URL(runFeedPath(feed, CODEX), "http://x");
  assert.equal(url.pathname, `/api/live/runs/${feed}`, "the id never lands in the path");
  assert.equal(url.searchParams.get("session"), CODEX);
}

const { auth } = await import("../lib/auth/server");
Object.assign(auth, {
  getSession: async () => ({ data: { user: { email: OWNER, emailVerified: true } }, error: null }),
});
const routes = {
  agents: await import("../app/api/live/runs/agents/route"),
  events: await import("../app/api/live/runs/events/route"),
  stages: await import("../app/api/live/runs/stages/route"),
};
for (const [feed, route] of Object.entries(routes)) {
  const call = (path: string) => route.POST(new Request(new URL(path, "http://localhost:3007"), { method: "POST" }));
  // With live updates off, getting past the id check ends at the seal, which answers 404.
  const resolved = await call(runFeedPath(feed as keyof typeof routes, CODEX));
  assert.equal(resolved.status, 404, `the ${feed} route accepts ${CODEX}`);
  assert.deepEqual(await resolved.json(), { error: "Live updates are off" });
  for (const bad of [`/api/live/runs/${feed}`, `/api/live/runs/${feed}?session=a%20b`]) {
    const rejected = await call(bad);
    assert.equal(rejected.status, 400, `the ${feed} route refuses ${bad}`);
  }
}

console.log("run links regressions passed");
