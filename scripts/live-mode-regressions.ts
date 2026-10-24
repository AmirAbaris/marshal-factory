import "./test-guard";
import assert from "node:assert/strict";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);

async function liveUpdatesFor(vercelEnv: string | undefined) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  const { default: config } = await import(`../next.config.ts?env=${vercelEnv}`);
  return (config as { env: Record<string, string> }).env.NEXT_PUBLIC_LIVE_UPDATES;
}
assert.equal(await liveUpdatesFor("preview"), "off", "a preview build turns live updates off");
assert.equal(await liveUpdatesFor("production"), "on", "a production build keeps live updates");
assert.equal(await liveUpdatesFor(undefined), "on", "a local build keeps live updates");
delete process.env.VERCEL_ENV;

process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";
// Preview deployments carry no Realtime config, so the panel must load without it.
delete process.env.NEON_REALTIME_SECRET;
const { auth } = await import("../lib/auth/server");
Object.assign(auth, {
  getSession: async () => ({ data: { user: { email: OWNER, emailVerified: true } }, error: null }),
});
const { load, runsQuery, sealedResponse } = await import("../lib/live-queries");

const feed = await load(runsQuery());
assert.equal(feed.sealedQuery, null, "a preview page hands the browser no sealed query");
assert.ok(Array.isArray(feed.initialData), "a preview page still shows the rows");

const renewal = await sealedResponse(runsQuery());
assert.equal(renewal.status, 404, "a preview live route seals nothing");
assert.deepEqual(await renewal.json(), { error: "Live updates are off" });

console.log("live mode regressions passed");
