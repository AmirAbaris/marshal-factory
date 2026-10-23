import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { issues } = await import("../db/schema");
const { claimConflict } = await import("../lib/conflicts");

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
  console.log("conflict regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(issues).where(eq(issues.linear_id, id));
  process.exit(process.exitCode ?? 0);
}
