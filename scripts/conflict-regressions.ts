import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { issues } = await import("../db/schema");
const { claimConflict, unclaimedRunsWithPr } = await import("../lib/conflicts");
const { runs } = await import("../db/schema");

const id = `conflict-regress-${Date.now()}`;
const now = new Date();
await db.insert(issues).values({ linear_id: id, key: id, title: "t", url: "u", stage: "pr", claimed_at: now, updated_at: now });
try {
  assert.equal(await claimConflict(db, id, "head-1"), true, "a new conflicting head is sent back");
  assert.equal(await claimConflict(db, id, "head-1"), false, "the same head is never sent back twice");
  await db.update(issues).set({ stage: "implementing" }).where(eq(issues.linear_id, id));
  assert.equal(await claimConflict(db, id, "head-2"), false, "an issue that left pr is not sent back");
  await db.update(issues).set({ stage: "pr" }).where(eq(issues.linear_id, id));
  assert.equal(await claimConflict(db, id, "head-2"), true, "a later head that conflicts again is sent back");
  const at = new Date();
  const loose = { session_id: `${id}-loose`, issue_key: `${id}-LOOSE`, pr_url: "https://x/pull/1", stage: "pr" as const, started_at: at, last_event_at: at };
  await db.insert(runs).values([loose, { ...loose, session_id: `${id}-claimed`, issue_key: id }]);
  const picked = (await unclaimedRunsWithPr(db)).map((r) => r.session_id);
  assert.ok(picked.includes(`${id}-loose`), "a hand-started run with a PR is checked for a merge");
  assert.ok(!picked.includes(`${id}-claimed`), "a claimed issue's run is left to the issue path");
  console.log("conflict regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(issues).where(eq(issues.linear_id, id));
  await db.delete(runs).where(inArray(runs.session_id, [`${id}-loose`, `${id}-claimed`]));
  process.exit(process.exitCode ?? 0);
}
