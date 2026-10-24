import { asc, eq } from "drizzle-orm";
import type { Stage } from "../lib/events";
import { attemptBranch, jobKeyFromBranch } from "../lib/factory";
import { canTransition, decideStage, type StageMove, type StageRow } from "../lib/stages";

// Replays every input that moves jobs.stage on the branch DATABASE_URL names (default: .env.local)
// through lib/stages.ts and through the rules ingest used before it, then compares the end state
// with each jobs row. Read-only. Exits 1 on any rejection, disagreement or row mismatch.
//   bun scripts/stage-history-check.ts
//
// The inputs, as the code applies them:
//   - stage events, including the ones the runner posts (merged, conflict, resume, budget, and the
//     watchdog and stop events it writes to the row first);
//   - reclaims, which the claim writes to the row with no event: one per attempt a later event's
//     branch or the row's attempt shows;
//   - direct row writes with no stored event (a `closed:` write, or a merge written before the
//     runner posted merges as events): the row's stage_event_id names no stored event.

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

type Input = StageMove & { attempt: number | undefined; refusal: string | null; direct: boolean };

const claimed = await db.select().from(jobs).orderBy(asc(jobs.key));
const history = await db
  .select({ eventId: events.event_id, at: events.at, key: events.job_key, payload: events.payload, refusal: events.refusal, runBranch: runs.branch })
  .from(events)
  .leftJoin(runs, eq(runs.session_id, events.session_id))
  .where(eq(events.kind, "stage"))
  .orderBy(asc(events.at), asc(events.event_id));

const rowKeys = new Set(claimed.map((j) => j.key));
const storedIds = new Set(history.map((e) => e.eventId));
const skipped = new Map<string, number>();
const inputs = new Map<string, Input[]>();
for (const event of history) {
  const reason = !event.key ? "no jobKey, so ingest moves no job" : rowKeys.has(event.key) ? undefined : `no jobs row for ${event.key}`;
  if (reason) {
    skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    continue;
  }
  const payload = event.payload as { stage: Stage; branch?: string };
  const list = inputs.get(event.key!) ?? [];
  list.push({
    stage: payload.stage,
    at: event.at,
    eventId: event.eventId,
    branch: payload.branch,
    attempt: attemptOf(event.key!, payload.branch ?? event.runBranch),
    refusal: event.refusal,
    direct: false,
  });
  inputs.set(event.key!, list);
}

const problems: string[] = [];
const notes: string[] = [];
let rejected = 0;
let replayed = 0;
let reclaims = 0;
const finals = [];
const reclaimed = (row: StageRow): StageRow => ({ ...row, stage: "queued", stage_at: null, attempt: row.attempt + 1, stage_event_id: null });

for (const job of claimed) {
  const list = inputs.get(job.key) ?? [];
  if (job.stage_event_id && !storedIds.has(job.stage_event_id)) {
    if (!job.stage_at) problems.push(`MISMATCH ${job.key}: stage_event_id ${job.stage_event_id} names no stored event and the row has no stage_at`);
    else {
      notes.push(`DIRECT ${job.key} ${job.stage_at.toISOString()} -> ${job.stage} (event ${job.stage_event_id}): written to the row with no stored event`);
      list.push({ stage: job.stage, at: job.stage_at, eventId: job.stage_event_id, attempt: job.attempt, refusal: null, direct: true });
      list.sort((a, b) => a.at.getTime() - b.at.getTime() || a.eventId.localeCompare(b.eventId));
    }
  }

  const start: StageRow = { key: job.key, stage: "queued", stage_at: null, attempt: 1, stage_event_id: null };
  let asIngested = start;
  let byTable = start;
  const reclaimTo = (attempt: number, why: string) => {
    while (attempt > byTable.attempt) {
      reclaims++;
      notes.push(`RECLAIM ${job.key} attempt ${byTable.attempt + 1} (${why})`);
      if (!canTransition(byTable.stage, "queued", "reclaim")) {
        rejected++;
        problems.push(`REJECTED ${job.key} attempt ${byTable.attempt + 1}: reclaim from ${byTable.stage} is not in the table`);
      }
      asIngested = reclaimed(asIngested);
      byTable = reclaimed(byTable);
    }
  };

  for (const input of list) {
    reclaimTo(input.attempt ?? byTable.attempt, `inferred from the branch of event ${input.eventId}`);
    const verdict = decideStage(byTable, input);
    replayed++;
    const what = `${job.key} ${input.at.toISOString()} ${byTable.stage} -> ${input.stage} (${verdict.cause}, event ${input.eventId})`;
    if (input.refusal) {
      if (verdict.outcome !== "refuse") problems.push(`STORED REFUSAL ${what}: ingest refused it (${input.refusal}) but the replay does not`);
      continue;
    }
    const applied = legacyApplies(asIngested, input);
    if (applied && verdict.outcome === "refuse") {
      rejected++;
      problems.push(`REJECTED ${what}: ${verdict.reason}; ingest applied it before`);
    }
    if (!applied && verdict.outcome === "apply") problems.push(`NEWLY ACCEPTED ${what}; ingest ignored it before`);
    const moved = { stage: input.stage, stage_at: input.at, stage_event_id: input.eventId };
    if (applied) asIngested = { ...asIngested, ...moved };
    if (verdict.outcome === "apply") byTable = { ...byTable, ...moved };
  }
  reclaimTo(job.attempt, "inferred from the row's attempt; no later event");

  const row = `${job.stage} a${job.attempt}`;
  const table = `${byTable.stage} a${byTable.attempt}`;
  const old = `${asIngested.stage} a${asIngested.attempt}`;
  finals.push({ key: job.key, "old rules": old, table, "jobs row": row });
  if (table !== row || old !== row || byTable.stage_event_id !== job.stage_event_id) {
    problems.push(`MISMATCH ${job.key}: replay ends at ${table} (old rules ${old}, event ${byTable.stage_event_id}), the row says ${row} (event ${job.stage_event_id})`);
  }
}

console.table(finals);
console.log(`${replayed} stage inputs and ${reclaims} reclaims replayed for ${claimed.length} jobs`);
const skippedTotal = [...skipped.values()].reduce((a, b) => a + b, 0);
console.log(`${skippedTotal} stage events skipped`);
for (const [reason, count] of skipped) console.log(`  ${count}: ${reason}`);
for (const line of notes) console.log(line);
for (const line of problems) console.log(line);
console.log(`${rejected} rejected transitions, ${problems.length} problems`);
process.exit(problems.length > 0 ? 1 : 0);
