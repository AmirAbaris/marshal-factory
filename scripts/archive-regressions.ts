import "./test-guard";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import type { JobRow } from "../db/schema";
import type { MergeDecision } from "../lib/merge-decision";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;

const { db } = await import("../db/client");
const { auditLog, jobs, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { archiveRefusal, isArchived, splitArchived } = await import("../lib/archive");
const { archiveJobs, unarchiveJobs } = await import("../lib/archive-actions");
const { inboxItems } = await import("../lib/inbox");
const { requestedStop } = await import("../lib/stop");
const { panelCards } = await import("../components/panel/cards");

// --- the rules, pure
const T = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000);
const fake = (over: Partial<JobRow>) => ({ stage: "merged", stage_at: T(0), updated_at: T(0), archived_at: null, stop: null, dismissed_at: null, ...over }) as JobRow;
assert.equal(isArchived(fake({ archived_at: T(1) })), true);
assert.equal(isArchived(fake({ stage: "failed", archived_at: T(0) })), true, "an archive at the stage's own time counts");
assert.equal(isArchived(fake({ archived_at: null })), false);
assert.equal(isArchived(fake({ stage: "queued", stage_at: T(2), archived_at: T(1) })), false, "a job reclaimed after its archive shows again");
assert.equal(isArchived(fake({ stage: "failed", stage_at: T(2), archived_at: T(1) })), false, "a failure newer than the archive shows again");
const revertFailed: MergeDecision = {
  outcome: "merge",
  reasons: [],
  autonomy: "auto",
  evaluatedAt: T(0).toISOString(),
  headSha: "h",
  headSeenAt: null,
  stageEventId: null,
  merged: { sha: "m", method: "squash", at: T(0).toISOString(), base: "main", title: "t", commits: 1 },
  watch: { state: "revert_failed", until: T(60).toISOString(), failed: ["ci"], revertPr: null, reason: "git revert failed" },
};
assert.equal(isArchived(fake({ archived_at: T(1), merge_decision: revertFailed })), false, "a revert that failed after the archive shows again");
assert.match(archiveRefusal(fake({ merge_decision: revertFailed })) ?? "", /revert failed/, "a failed revert is resolved in the inbox, not archived");
assert.equal(isArchived(fake({ archived_at: T(1), merge_decision: { ...revertFailed, watch: { state: "green", until: T(60).toISOString(), failed: [], revertPr: null, reason: null } } })), true, "a merge whose watch passed stays archived");
for (const stage of ["queued", "triage", "investigating", "implementing", "verifying", "pr", "waiting"] as const) {
  assert.equal(archiveRefusal(fake({ stage })), "Only merged or failed jobs can be archived.", `a job in ${stage} is not archived`);
}
assert.equal(archiveRefusal(fake({ stage: "failed" })), null);
assert.equal(archiveRefusal(fake({ stage: "failed", stop: requestedStop({ at: T(0), by: OWNER, reason: "r", reopen: false }) })), "The job's stop isn't confirmed yet.", "a stop on its way may leave an agent running");

// --- the actions, against the branch
const KEYS = { merged: "ARCH-MERGED", failed: "ARCH-FAILED", working: "ARCH-WORKING", pr: "ARCH-PR", waiting: "ARCH-WAITING", stopping: "ARCH-STOPPING" } as const;
await db.delete(auditLog).where(like(auditLog.id, "%:linear:archive-regress-%"));
await db.delete(runs).where(like(runs.session_id, "archive-regress-%"));
await db.delete(jobs).where(like(jobs.key, "ARCH-%"));
const past = new Date(Date.now() - 60_000);
await db.insert(jobs).values([
  linearJob("archive-regress-merged", KEYS.merged, { stage: "merged", stage_at: past, pr_url: "https://github.com/o/r/pull/1" }),
  linearJob("archive-regress-failed", KEYS.failed, { stage: "failed", stage_at: past }),
  linearJob("archive-regress-working", KEYS.working, { stage: "implementing", stage_at: past }),
  linearJob("archive-regress-pr", KEYS.pr, { stage: "pr", stage_at: past, pr_url: "https://github.com/o/r/pull/2" }),
  linearJob("archive-regress-waiting", KEYS.waiting, { stage: "waiting", stage_at: past, question: "Which one?" }),
  linearJob("archive-regress-stopping", KEYS.stopping, { stage: "failed", stage_at: past, stop: requestedStop({ at: past, by: OWNER, reason: "r", reopen: false }) }),
]);
// A staged run of the failed job, which must not come back as a run the factory never claimed.
await db.insert(runs).values({ session_id: "archive-regress-run", job_key: KEYS.failed, stage: "failed", started_at: past, last_event_at: past });

const idOf = async (key: string) => (await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.key, key)))[0]!.id;
const ids = Object.fromEntries(await Promise.all(Object.entries(KEYS).map(async ([k, key]) => [k, await idOf(key)]))) as Record<keyof typeof KEYS, JobRow["id"]>;
const owner = { email: OWNER, emailVerified: true };
const deps = (user: typeof owner | null = owner) => ({ db, user: async () => user });
const rows = async () => db.select().from(jobs).where(like(jobs.key, "ARCH-%"));
const audits = async () => db.select().from(auditLog).where(inArray(auditLog.job_id, Object.values(ids)));
const panel = async () => {
  const all = await rows();
  const jobRuns = await db.select().from(runs).where(eq(runs.session_id, "archive-regress-run"));
  const { shown, archived } = splitArchived(all);
  const cards = panelCards(all, jobRuns);
  return {
    shown: shown.map((j) => j.key).sort(),
    archived: archived.map((j) => j.key).sort(),
    inbox: inboxItems(shown).map((i) => i.job.key).sort(),
    cards: cards.live.map((c) => c.id).sort(),
    archivedCards: cards.archived.map((c) => c.id).sort(),
  };
};

const before = await panel();
assert.deepEqual(before.archived, []);
assert.ok(before.inbox.includes(KEYS.failed), "the failed job starts in the inbox");

for (const user of [null, { email: "stranger@example.com", emailVerified: true }, { email: OWNER, emailVerified: false }]) {
  assert.deepEqual(await archiveJobs(deps(user), [ids.merged]), { ok: false, message: "Only the factory owner can archive jobs." }, "only the owner archives");
  assert.deepEqual(await unarchiveJobs(deps(user), [ids.merged]), { ok: false, message: "Only the factory owner can archive jobs." }, "only the owner restores");
}
assert.deepEqual(await archiveJobs(deps(), []), { ok: false, message: "Pick at least one job." });
assert.deepEqual(await archiveJobs(deps(), "nope"), { ok: false, message: "Invalid input: expected array, received string" }, "the ids are validated");
assert.deepEqual(await archiveJobs(deps(), ["linear:archive-regress-missing"]), { ok: false, message: "No job linear:archive-regress-missing." });
for (const kind of ["working", "pr", "waiting"] as const) {
  assert.deepEqual(await archiveJobs(deps(), [ids[kind]]), { ok: false, message: `${KEYS[kind]}: Only merged or failed jobs can be archived.` }, `a job in ${kind} is refused`);
}
assert.deepEqual(await archiveJobs(deps(), [ids.stopping]), { ok: false, message: `${KEYS.stopping}: The job's stop isn't confirmed yet.` });
assert.deepEqual(await archiveJobs(deps(), [ids.merged, ids.working]), { ok: false, message: `${KEYS.working}: Only merged or failed jobs can be archived.` }, "one active job refuses the whole request");
assert.ok((await rows()).every((j) => j.archived_at === null), "a refused request archives nothing");
assert.deepEqual(await audits(), []);

assert.deepEqual(await archiveJobs(deps(), [ids.merged, ids.failed, ids.merged]), { ok: true, message: "Archived 2 jobs." });
const archivedRows = (await rows()).filter((j) => j.archived_at);
assert.deepEqual(archivedRows.map((j) => [j.key, j.archived_by, j.stage]).sort(), [[KEYS.failed, OWNER, "failed"], [KEYS.merged, OWNER, "merged"]], "only the archive columns change");
assert.deepEqual(
  (await audits()).map((a) => [a.action, a.actor, a.target, a.result]).sort(),
  [["job_archived", OWNER, "https://github.com/o/r/pull/1", "ok"], ["job_archived", OWNER, "u", "ok"]],
  "one audit row per job",
);

const after = await panel();
assert.deepEqual(after.archived, [KEYS.failed, KEYS.merged].sort());
assert.ok(!after.shown.includes(KEYS.merged) && !after.shown.includes(KEYS.failed), "archived jobs leave the jobs the panel shows");
assert.ok(!after.inbox.includes(KEYS.failed), "an archived failure leaves the inbox");
assert.ok(after.inbox.includes(KEYS.waiting), "the rest of the inbox stays");
assert.ok(!after.cards.includes(KEYS.failed) && !after.cards.includes(KEYS.merged), "archived jobs leave the board and the list");
assert.ok(!after.cards.includes("archive-regress-run"), "an archived job's run doesn't come back as an unclaimed run");
assert.deepEqual(after.archivedCards, [KEYS.failed, KEYS.merged].sort(), "the archive lists them");

assert.deepEqual(await archiveJobs(deps(), [ids.merged]), { ok: true, message: "Archived 1 job." }, "archiving again is fine");
assert.equal((await audits()).length, 2, "and audits nothing new");

assert.deepEqual(await unarchiveJobs(deps(), [ids.failed]), { ok: true, message: "Restored 1 job." });
const [restored] = await db.select().from(jobs).where(eq(jobs.id, ids.failed));
assert.deepEqual([restored!.archived_at, restored!.archived_by, restored!.stage], [null, null, "failed"]);
const back = await panel();
assert.ok(back.shown.includes(KEYS.failed) && back.inbox.includes(KEYS.failed) && back.cards.includes(KEYS.failed), "unarchive puts the job back on the board and in the inbox");
assert.deepEqual(await unarchiveJobs(deps(), [ids.failed]), { ok: true, message: "Restored 1 job." }, "restoring again is fine");
assert.deepEqual(
  (await audits()).filter((a) => a.action === "job_unarchived").map((a) => [a.job_id, a.actor]),
  [[ids.failed, OWNER]],
  "and audits only the real restore",
);

// A reclaim moves the archived job on; it shows again without anyone unarchiving it.
await db.update(jobs).set({ stage: "queued", stage_at: new Date(Date.now() + 60_000) }).where(eq(jobs.id, ids.merged));
assert.ok((await panel()).shown.includes(KEYS.merged), "a job moved on after its archive is back on the board");

// The runner and ingest never read the archive.
const sources = [
  ...readdirSync(join(import.meta.dirname, "../runner"), { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => join("runner", f)),
  "lib/ingest.ts",
];
for (const file of sources) {
  assert.ok(!readFileSync(join(import.meta.dirname, "..", file), "utf8").includes("archived_"), `${file} doesn't read the archive`);
}

await db.delete(auditLog).where(inArray(auditLog.job_id, Object.values(ids)));
await db.delete(runs).where(like(runs.session_id, "archive-regress-%"));
await db.delete(jobs).where(like(jobs.key, "ARCH-%"));
console.log("archive regressions passed");
process.exit(0);
