import "./test-guard";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import type { MergeAssessment } from "../lib/assessment";
import type { FactoryEvent } from "../lib/events";
import type { DecisionInput } from "../lib/merge-decision";

process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);
process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";

const { db } = await import("../db/client");
const { events, jobs, jobScreenshots, runs } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { attemptBranch } = await import("../lib/factory");
const { eventSchema, stageReportSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { parseAssessment } = await import("../lib/assessment");
const { appendEvent, flushOutbox, localFs } = await import("../lib/outbox");
const { decideMerge, DEFAULT_POLICY } = await import("../lib/merge-decision");
const { MAX_SCREENSHOT_BYTES, screenshotUrl, sniffType, uiFiles } = await import("../lib/screenshots");
const { readScreenshot, screenshotEvents, unreadable } = await import("../lib/screenshot-files");
const { GET } = await import("../app/api/jobs/[key]/screenshots/[index]/route");

const stamp = Date.now() % 1_000_000;
const dir = mkdtempSync(join(tmpdir(), "screenshot-regress-"));
const browser = join(dir, "browser");
mkdirSync(browser);
const KEY = `SHOT-${stamp}`;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
writeFileSync(join(browser, "list.png"), PNG);
writeFileSync(join(browser, "empty.jpeg"), JPEG);
writeFileSync(join(browser, "notes.txt"), "not an image");
writeFileSync(join(browser, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_SCREENSHOT_BYTES)]));
writeFileSync(join(dir, "outside.png"), PNG);
symlinkSync(join(dir, "outside.png"), join(browser, "escape.png"));

const assessment = (over: Partial<MergeAssessment> = {}): MergeAssessment => ({
  recommendation: "merge",
  interpretation: "Sort the list by name.",
  assumptions: [],
  confidence: { confident: true },
  ...over,
});
const shots = [
  { file: "list.png", caption: "The list sorted by name." },
  { file: "empty.jpeg", caption: "The empty state." },
];

try {
  // --- the files the agent may attach
  assert.equal(sniffType(PNG), "image/png");
  assert.equal(sniffType(JPEG), "image/jpeg");
  assert.equal(sniffType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffType(Buffer.from("<svg/>")), null, "an SVG could carry script, so it is no screenshot");
  const read = readScreenshot("list.png", browser);
  assert.ok(read.ok && read.contentType === "image/png" && read.bytes.equals(PNG), "a file the browser saved reads back as itself");
  assert.ok(readScreenshot(join(browser, "list.png"), browser).ok, "an absolute path inside the dir is fine");
  const refusal = (file: string) => {
    const r = readScreenshot(file, browser);
    return r.ok ? null : r.reason;
  };
  assert.match(refusal("gone.png")!, /does not exist/);
  assert.match(refusal("notes.txt")!, /not a PNG, JPEG or WebP/);
  assert.match(refusal("huge.png")!, /over the 1000000 limit/);
  assert.match(refusal(join(dir, "outside.png"))!, /not inside/, "a file outside the browser's dir");
  assert.match(refusal("../outside.png")!, /not inside/, "a relative path out of the dir");
  assert.match(refusal("escape.png")!, /not inside/, "a symlink out of the dir");
  assert.deepEqual(unreadable([...shots, { file: "notes.txt", caption: "x" }], browser), ["notes.txt is not a PNG, JPEG or WebP image"], "only the bad file is named");

  // --- the report_stage shape
  const pr = { stage: "pr", summary: "Opened", prUrl: "https://github.com/o/r/pull/1" };
  assert.ok(stageReportSchema.safeParse({ ...pr, assessment: assessment({ screenshots: shots }) }).success, "an assessment takes screenshots");
  assert.ok(!stageReportSchema.safeParse({ ...pr, assessment: assessment({ screenshots: Array.from({ length: 7 }, () => shots[0]!) }) }).success, "at most six");
  assert.ok(!stageReportSchema.safeParse({ ...pr, assessment: assessment({ screenshots: [{ file: "list.png", caption: "" }] }) }).success, "each needs a caption");
  assert.deepEqual(parseAssessment(assessment({ screenshots: shots }))?.screenshots, shots, "a stored assessment keeps its screenshots");
  assert.equal(parseAssessment({ ...assessment(), screenshots: [] })?.screenshots, undefined, "an empty list reads as none");

  // --- the events the reporter sends
  const stageEventId = `stage-${stamp}`;
  const sessionId = `mcp:${attemptBranch(KEY, 1)}`;
  const images = screenshotEvents([...shots, shots[0]!, { file: "notes.txt", caption: "x" }], { jobKey: KEY, stageEventId, sessionId, at: Date.now() }, browser);
  assert.deepEqual(images.map((e) => e.file), ["list.png", "empty.jpeg"], "one event per readable file, in the assessment's order");
  for (const image of images) assert.ok(eventSchema.safeParse(image).success, `${image.file} is a valid event`);
  assert.equal(images[0]!.eventId, screenshotEvents(shots, { jobKey: KEY, stageEventId, sessionId, at: 0 }, browser)[0]!.eventId, "a retried report sends the same ids");
  assert.ok(!eventSchema.safeParse({ ...images[0], data: Buffer.alloc(MAX_SCREENSHOT_BYTES + 3).toString("base64") }).success, "ingest refuses an image over the limit");

  // --- the outbox keeps a batch of images under one request's size
  {
    const state = join(dir, "outbox");
    for (const image of images) appendEvent(state, image as FactoryEvent);
    appendEvent(state, { eventId: `small-${stamp}`, sessionId, at: Date.now(), kind: "session_end" });
    const batches: string[][] = [];
    const flushed = await flushOutbox(localFs, state, async (batch) => (batches.push(batch.map((e) => e.eventId)), { kind: "delivered" }), { budgetMs: 5_000, maxChars: 300 });
    assert.equal(flushed.delivered, 3);
    assert.deepEqual(batches.flat(), [...images.map((e) => e.eventId), `small-${stamp}`], "still oldest first");
    assert.ok(batches.length === 3 && batches.every((b) => b.length === 1), `each event over the cap goes alone: ${JSON.stringify(batches)}`);
  }

  // --- ingest stores the bytes once, and the panel serves the current report's images
  await db.insert(jobs).values(linearJob(`screenshot-regress-${KEY}`, KEY, { machine_id: TEST_MACHINE_ID, stage: "verifying", attempt: 1 }));
  const stage: FactoryEvent = { eventId: stageEventId, sessionId, at: Date.now(), kind: "stage", ...pr, stage: "pr", assessment: assessment({ screenshots: shots }), jobKey: KEY, branch: attemptBranch(KEY, 1) };
  const first = await ingest(db, [...images, stage]);
  assert.equal(first.inserted, 3);
  assert.deepEqual(first.refused, [], "the pr report applies");
  const again = await ingest(db, images);
  assert.equal(again.inserted, 0, "a redelivered image changes nothing");
  const stored = await db.select().from(jobScreenshots).where(eq(jobScreenshots.job_key, KEY));
  assert.deepEqual(stored.map((s) => [s.file, s.content_type, s.stage_event_id]).sort(), [["empty.jpeg", "image/jpeg", stageEventId], ["list.png", "image/png", stageEventId]]);
  assert.ok(Buffer.from(stored.find((s) => s.file === "list.png")!.bytes).equals(PNG), "the bytes round-trip");
  const logged = await db.select({ payload: events.payload }).from(events).where(inArray(events.event_id, images.map((e) => e.eventId)));
  assert.ok(logged.every((l) => (l.payload as { data: string }).data === ""), "the event log keeps no image bytes");
  const [job] = await db.select().from(jobs).where(eq(jobs.key, KEY));
  assert.equal(job!.stage, "pr");
  assert.equal(job!.stage_event_id, stageEventId);
  assert.equal(job!.assessment_event_id, stageEventId, "the job remembers which report its assessment came from");

  const get = (index: number, v: string | null = stageEventId) => GET(new Request(`http://panel${screenshotUrl(KEY, index, v)}`), { params: Promise.resolve({ key: KEY, index: String(index) }) } as never);
  const one = await get(0);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await one.arrayBuffer()).equals(PNG), "the panel serves the stored image");
  assert.equal((await get(1)).headers.get("content-type"), "image/jpeg");
  assert.equal((await get(2)).status, 404, "past the assessment's list");
  assert.equal((await get(0, "older-report")).status, 404, "a URL from an earlier report never shows this report's image");

  // A later stage moves stage_event_id; the assessment and its images belong to the pr report still.
  const after: FactoryEvent = { eventId: `${stageEventId}-failed`, sessionId, at: Date.now() + 1, kind: "stage", stage: "failed", summary: "CI kept failing.", jobKey: KEY, branch: attemptBranch(KEY, 1) };
  assert.deepEqual((await ingest(db, [after])).refused, [], "the later stage applies");
  const [moved] = await db.select().from(jobs).where(eq(jobs.key, KEY));
  assert.equal(moved!.stage_event_id, after.eventId);
  assert.equal(screenshotUrl(KEY, 0, moved!.assessment_event_id), screenshotUrl(KEY, 0, stageEventId), "the panel's URL stays the pr report's");
  assert.equal((await get(0)).status, 200, "the images still serve after a later stage");
  await db.update(jobs).set({ stage: "pr" }).where(eq(jobs.key, KEY));

  // A report naming a file whose image never arrived: the panel says so instead of showing another.
  const later: FactoryEvent = { ...stage, eventId: `${stageEventId}-2`, at: Date.now() + 2, assessment: assessment({ screenshots: [{ file: "late.png", caption: "Late." }] }) };
  await ingest(db, [later]);
  assert.equal((await get(0, later.eventId)).status, 404, "an image that hasn't arrived");

  // --- the merge decision: a UI change needs screenshots when the agent had a browser
  const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    policy: { ...DEFAULT_POLICY, autonomy: "auto" },
    assessment: assessment(),
    labels: [],
    pr: { headSha: "h1", mergeable: "mergeable", checks: "success", bugbot: { review: { state: "reviewed" }, findings: [] }, files: [{ path: "src/list.tsx", additions: 3, deletions: 1 }] },
    headSeenAt: 0,
    now: 1,
    evidence: { state: "verified", sha: "h1", passed: 1, total: 1, producer: "agent" },
    runner: { kind: "unavailable", reason: "n/a" },
    browser: true,
    trustEdits: [],
    ...over,
  });
  assert.deepEqual(decideMerge(input()), { outcome: "handover", reasons: ["The pull request changes UI files (src/list.tsx), but the agent attached no screenshots."] }, "a UI change without screenshots hands over");
  assert.deepEqual(decideMerge(input({ assessment: assessment({ screenshots: shots }) })), { outcome: "merge", reasons: [] }, "with screenshots it merges");
  assert.deepEqual(decideMerge(input({ browser: false })), { outcome: "merge", reasons: [] }, "a run with no browser can't take them, so it isn't held to them");
  const many = ["a.tsx", "b.css", "c.vue", "d.html", "e.ts"].map((path) => ({ path, additions: 1, deletions: 0 }));
  assert.match(decideMerge(input({ pr: { ...input().pr!, files: many } })).reasons[0]!, /\(a\.tsx, b\.css, c\.vue and 1 more\)/, "names three and counts the rest");
  assert.deepEqual(decideMerge(input({ pr: { ...input().pr!, files: [{ path: "lib/sort.ts", additions: 3, deletions: 1 }] } })), { outcome: "merge", reasons: [] }, "a change no page shows needs none");
  assert.deepEqual(uiFiles(["app/page.tsx", "styles/site.scss", "README.md", "lib/a.ts"]), ["app/page.tsx", "styles/site.scss"]);

  console.log("screenshot regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobScreenshots).where(eq(jobScreenshots.job_key, KEY));
  await db.delete(events).where(eq(events.job_key, KEY));
  await db.delete(runs).where(eq(runs.job_key, KEY));
  await db.delete(jobs).where(eq(jobs.key, KEY));
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
