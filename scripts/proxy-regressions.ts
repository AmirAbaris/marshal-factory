import "./test-guard";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);

const { auth, assertOwner } = await import("../lib/auth/server");
const REFRESHED = "x-session-refreshed";
Object.assign(auth, {
  middleware: () => async () => NextResponse.next({ headers: { [REFRESHED]: "1" } }),
});
const { proxy, config } = await import("../proxy");

type Who = "anonymous" | "stranger" | "unverified" | "owner";
const SESSIONS: Record<Who, { user: { email: string; emailVerified: boolean } } | null> = {
  anonymous: null,
  stranger: { user: { email: "stranger@example.com", emailVerified: true } },
  unverified: { user: { email: OWNER, emailVerified: false } },
  owner: { user: { email: OWNER.toUpperCase(), emailVerified: true } },
};
function signInAs(who: Who) {
  Object.assign(auth, { getSession: async () => ({ data: SESSIONS[who], error: null }) });
}

async function request(who: Who, path: string, method = "GET") {
  signInAs(who);
  return proxy(new NextRequest(`http://localhost:3000${path}`, { method }));
}

const anonymousPage = await request("anonymous", "/");
assert.equal(anonymousPage.status, 307, "a page without a session redirects");
assert.equal(anonymousPage.headers.get("location"), "http://localhost:3000/auth/sign-in");

const anonymousSeal = await request("anonymous", "/api/live/runs", "POST");
assert.equal(anonymousSeal.status, 401, "a live route without a session is unauthorized");
assert.deepEqual(await anonymousSeal.json(), { error: "Unauthorized" });
assert.equal(anonymousSeal.headers.get(REFRESHED), null);

for (const who of ["stranger", "unverified"] as const) {
  const page = await request(who, "/");
  assert.equal(page.status, 403, `a page request from the ${who} account is forbidden`);
  assert.equal(page.headers.get("x-middleware-rewrite"), "http://localhost:3000/auth/forbidden", `the ${who} account sees the forbidden page`);
  assert.equal(page.headers.get(REFRESHED), null);

  const seal = await request(who, "/api/live/runs", "POST");
  assert.equal(seal.status, 403, `a live route request from the ${who} account is forbidden`);
  assert.deepEqual(await seal.json(), { error: "Forbidden" });
}

for (const path of ["/", "/api/live/runs"]) {
  const response = await request("owner", path, path.startsWith("/api/") ? "POST" : "GET");
  assert.equal(response.status, 200, `the owner passes through ${path}`);
  assert.equal(response.headers.get(REFRESHED), "1", `the owner reaches ${path} through the session refresh`);
}

const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const path of ["/", "/api/live/runs", "/api/live/jobs/FAC-7/stages", "/machines", "/authors", "/auth/settings", "/auth/sign-in-evil", "/auth/sign-upx", "/auth/forbiddenx", "/favicon.icox", "/faviconxico", "/api/authx", "/api/slackx", "/_next/staticx", "/auth/sign-in.evil"]) {
  assert.ok(matcher.test(path), `the proxy guards ${path}`);
}
for (const path of ["/auth/sign-in", "/auth/sign-in/", "/auth/sign-in.rsc", "/auth/sign-in.segments/_tree.segment.rsc", "/auth/sign-up", "/auth/forbidden", "/api/auth/sign-in/email", "/api/slack/interactions", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
  assert.ok(!matcher.test(path), `the proxy lets ${path} through without a session`);
}

for (const who of ["anonymous", "stranger", "unverified"] as const) {
  signInAs(who);
  await assert.rejects(assertOwner(), /owner session is required/, `the seal refuses ${who}`);
}
const { load, runJob, runsQuery, sealedResponse } = await import("../lib/live-queries");
signInAs("unverified");
await assert.rejects(sealedResponse(runsQuery()), /owner session is required/, "an unverified owner gets no sealed query");
await assert.rejects(load(runsQuery()), /owner session is required/, "an unverified owner gets no rows or sealed query");
for (const who of ["anonymous", "stranger", "unverified"] as const) {
  signInAs(who);
  await assert.rejects(runJob("no-such-session"), /owner session is required/, `the job lookup refuses ${who}`);
}
signInAs("owner");
await assertOwner();
assert.deepEqual(await runJob("no-such-session"), { jobKey: undefined, jobId: undefined }, "the owner can look up a run's job");
const sealed = await sealedResponse(runsQuery());
assert.equal(sealed.status, 200, "the verified owner gets a sealed query");
assert.equal(sealed.headers.get("cache-control"), "no-store");

console.log("proxy regressions passed");
