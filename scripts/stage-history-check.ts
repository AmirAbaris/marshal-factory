import { asc, eq, inArray } from "drizzle-orm";
import type { Stage } from "../lib/events";
import { attemptBranch, jobKeyFromBranch } from "../lib/factory";
import { canTransition, decideStage, type StageMove, type StageRow } from "../lib/stages";

// Replays every stage event on the branch DATABASE_URL names (default: .env.local) through
// lib/stages.ts and through the rules ingest used before it, and prints every event they judge
// differently. Read-only.
//   bun scripts/stage-history-check.ts

try {
  process.loadEnvFile(".env.local");
} catch {
}
const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");

function legacyApplies(row: StageRow, move: StageMove) {
  if (row.stage_at && move.at < row.stage_at) return false;
  if (move.branch) return move.branch === attemptBranch(row.key, row.attempt) && row.stage !== "failed";
  return true;
}

const attemptOf = (key: string, branch: string | null | undefined) =>
  branch && jobKeyFromBranch(branch) === key ? Number(/-a(\d+)$/.exec(branch)?.[1] ?? 1) : undefined;

const claimed = await db.select().from(jobs).orderBy(asc(jobs.key));
const history = await db
  .select({ eventId: events.event_id, at: events.at, key: events.job_key, payload: events.payload, runBranch: runs.branch })
  .from(events)
  .leftJoin(runs, eq(runs.session_id, events.session_id))
  .where(inArray(events.job_key, claimed.length ? claimed.map((j) => j.key) : [""]))
  .orderBy(asc(events.job_key), asc(events.at), asc(events.event_id));

const disagreements: string[] = [];
let rejected = 0;
let replayed = 0;
let reclaims = 0;
const finals = [];
const reclaimed = (row: StageRow): StageRow => ({ ...row, stage: "queued", stage_at: null, attempt: row.attempt + 1, stage_event_id: null });

for (const job of claimed) {
  const start: StageRow = { key: job.key, stage: "queued", stage_at: null, attempt: 1, stage_event_id: null };
  let asIngested = start;
  let byTable = start;
  for (const event of history.filter((e) => e.key === job.key)) {
    const payload = event.payload as { stage: Stage; branch?: string };
    const attempt = attemptOf(job.key, payload.branch ?? event.runBranch) ?? asIngested.attempt;
    while (attempt > asIngested.attempt) {
      reclaims++;
      if (!canTransition(asIngested.stage, "queued", "reclaim")) {
        rejected++;
        disagreements.push(`REJECTED ${job.key} attempt ${asIngested.attempt + 1}: reclaim from ${asIngested.stage} is not in the table`);
      }
      asIngested = reclaimed(asIngested);
      byTable = reclaimed(byTable);
    }
    const move: StageMove = { stage: payload.stage, at: event.at, eventId: event.eventId, branch: payload.branch };
    const applied = legacyApplies(asIngested, move);
    const verdict = decideStage(asIngested, move);
    replayed++;
    const what = `${job.key} ${event.at.toISOString()} ${asIngested.stage} -> ${move.stage} (${verdict.cause}, event ${event.eventId})`;
    if (applied && !verdict.apply) {
      rejected++;
      disagreements.push(`REJECTED ${what}: ${verdict.reason}; ingest applied it before`);
    }
    if (!applied && verdict.apply) disagreements.push(`NEWLY ACCEPTED ${what}; ingest ignored it before`);
    const moved = { stage: move.stage, stage_at: move.at, stage_event_id: move.eventId };
    if (applied) asIngested = { ...asIngested, ...moved };
    if (decideStage(byTable, move).apply) byTable = { ...byTable, ...moved };
  }
  finals.push({ key: job.key, "old rules": `${asIngested.stage} a${asIngested.attempt}`, table: `${byTable.stage} a${byTable.attempt}`, "jobs row": `${job.stage} a${job.attempt}` });
}

console.table(finals);
console.log(`${replayed} stage events and ${reclaims} reclaims replayed for ${claimed.length} jobs`);
for (const line of disagreements) console.log(line);
console.log(`${rejected} rejected transitions`);
process.exit(disagreements.length > 0 ? 1 : 0);
