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
  // DATABASE_URL comes from the shell.
}
const { db } = await import("../db/client");
const { events, jobs, runs } = await import("../db/schema");

/** The rules lib/ingest.ts applied before lib/stages.ts: stage_at order, and a thread's report only on the current attempt, never after failed. */
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
for (const job of claimed) {
  const start: StageRow = { key: job.key, stage: "queued", stage_at: null, attempt: 1, stage_event_id: null };
  // `before` follows the rules ingest used to apply, `after` follows the table.
  let before = start;
  let after = start;
  for (const event of history.filter((e) => e.key === job.key)) {
    const payload = event.payload as { stage: Stage; branch?: string };
    // Retries happen in the claim, not in an event; a later attempt's event implies them.
    const attempt = attemptOf(job.key, payload.branch ?? event.runBranch) ?? before.attempt;
    while (attempt > before.attempt) {
      reclaims++;
      if (!canTransition(before.stage, "queued", "reclaim")) {
        rejected++;
        disagreements.push(`REJECTED ${job.key} attempt ${before.attempt + 1}: reclaim from ${before.stage} is not in the table`);
      }
      const reclaimed = { stage: "queued" as const, stage_at: null, attempt: before.attempt + 1, stage_event_id: null };
      before = { ...before, ...reclaimed };
      after = { ...after, ...reclaimed };
    }
    const move: StageMove = { stage: payload.stage, at: event.at, eventId: event.eventId, branch: payload.branch };
    const applied = legacyApplies(before, move);
    const verdict = decideStage(before, move);
    replayed++;
    const what = `${job.key} ${event.at.toISOString()} ${before.stage} -> ${move.stage} (${verdict.cause}, event ${event.eventId})`;
    if (applied && !verdict.apply) {
      rejected++;
      disagreements.push(`REJECTED ${what}: ${verdict.reason}; ingest applied it before`);
    }
    if (!applied && verdict.apply) disagreements.push(`NEWLY ACCEPTED ${what}; ingest ignored it before`);
    const moved = { stage: move.stage, stage_at: move.at, stage_event_id: move.eventId };
    if (applied) before = { ...before, ...moved };
    if (decideStage(after, move).apply) after = { ...after, ...moved };
  }
  finals.push({ key: job.key, "old rules": `${before.stage} a${before.attempt}`, table: `${after.stage} a${after.attempt}`, "jobs row": `${job.stage} a${job.attempt}` });
}

console.table(finals);
console.log(`${replayed} stage events and ${reclaims} reclaims replayed for ${claimed.length} jobs`);
for (const line of disagreements) console.log(line);
console.log(`${rejected} rejected transitions`);
process.exit(disagreements.length > 0 ? 1 : 0);
