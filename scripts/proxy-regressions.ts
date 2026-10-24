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

type Who = "anonymous" | "stranger" | "owner";
const SESSIONS: Record<Who, { user: { email: string } } | null> = {
  anonymous: null,
  stranger: { user: { email: "stranger@example.com" } },
  owner: { user: { email: OWNER.toUpperCase() } },
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

const strangerPage = await request("stranger", "/");
assert.equal(strangerPage.status, 403, "a non-owner page request is forbidden");
assert.equal(strangerPage.headers.get("x-middleware-rewrite"), "http://localhost:3000/auth/forbidden", "a non-owner sees the forbidden page");

const strangerSeal = await request("stranger", "/api/live/runs", "POST");
assert.equal(strangerSeal.status, 403, "a non-owner live route request is forbidden");
assert.deepEqual(await strangerSeal.json(), { error: "Forbidden" });

for (const path of ["/", "/api/live/runs", "/auth/sign-in"]) {
  const response = await request("owner", path, path.startsWith("/api/") ? "POST" : "GET");
  assert.equal(response.status, 200, `the owner passes through ${path}`);
  assert.equal(response.headers.get(REFRESHED), "1", `the owner reaches ${path} through the session refresh`);
}

const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const path of ["/", "/api/live/runs", "/api/live/jobs/FAC-7/stages", "/machines", "/authors"]) {
  assert.ok(matcher.test(path), `the proxy guards ${path}`);
}
for (const path of ["/auth/sign-in", "/auth/forbidden", "/api/auth/sign-in/email", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
  assert.ok(!matcher.test(path), `the proxy lets ${path} through without a session`);
}

for (const who of ["anonymous", "stranger"] as const) {
  signInAs(who);
  await assert.rejects(assertOwner(), /owner session is required/, `the seal refuses ${who}`);
}
signInAs("owner");
await assertOwner();

console.log("proxy regressions passed");
