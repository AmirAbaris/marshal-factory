import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { and, asc, desc, eq, getTableColumns, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, events, jobs, runs } from "@/db/schema";
import { assertOwner } from "@/lib/auth/server";
import { liveUpdates } from "@/lib/live-mode";

const createPanelRealtime = () =>
  createRealtime({
    secret: process.env.NEON_REALTIME_SECRET!,
    db: new URL(process.env.DATABASE_URL!).pathname.slice(1),
    adapter: drizzleAdapter(),
  });

type SealableQuery = Parameters<ReturnType<typeof createPanelRealtime>["seal"]>[0]["query"];

// A preview build has no Realtime secret, and createRealtime rejects a missing one.
const realtime = liveUpdates ? createPanelRealtime() : null;

export const RUN_LIMIT = 200;
export const AGENT_OVERVIEW_LIMIT = 1000;
export const SESSION_AGENT_LIMIT = 200;
export const FEED_LIMIT = 50;

// Live queries must be deterministic, so none of these read the clock.

export const runsQuery = () =>
  db
    .select(getTableColumns(runs))
    .from(runs)
    .orderBy(desc(runs.last_event_at))
    .limit(RUN_LIMIT);

/** Feeds per-card agent counts and cost on the board. */
export const agentsOverviewQuery = () =>
  db
    .select(getTableColumns(agents))
    .from(agents)
    .orderBy(desc(agents.started_at))
    .limit(AGENT_OVERVIEW_LIMIT);

export const sessionAgentsQuery = (sessionId: string) =>
  db
    .select(getTableColumns(agents))
    .from(agents)
    .where(eq(agents.session_id, sessionId))
    .orderBy(agents.started_at)
    .limit(SESSION_AGENT_LIMIT);

export const sessionEventsQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    // Usage snapshots arrive every half minute and would push everything else out of the feed.
    .where(and(eq(events.session_id, sessionId), ne(events.kind, "usage")))
    .orderBy(desc(events.at), desc(events.event_id))
    .limit(FEED_LIMIT);

export const JOB_LIMIT = 200;

export const jobsQuery = () =>
  db
    .select(getTableColumns(jobs))
    .from(jobs)
    .orderBy(desc(jobs.claimed_at))
    .limit(JOB_LIMIT);

export const STAGE_HISTORY_LIMIT = 100;

export const sessionStagesQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.session_id, sessionId), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

/** Every stage report for a job, across all the sessions that worked on it. */
export const jobStagesQuery = (jobKey: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.job_key, jobKey), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

export async function runJobKey(sessionId: string) {
  const [row] = await db
    .select({ jobKey: runs.job_key })
    .from(runs)
    .where(eq(runs.session_id, sessionId));
  return row?.jobKey ?? undefined;
}

/** Runs the query for server rendering and seals it for the browser subscription. */
export async function load<Q extends SealableQuery>(
  query: Q,
) {
  await assertOwner();
  const [initialData, sealedQuery] = await Promise.all([
    query,
    realtime ? realtime.seal({ query }) : null,
  ]);
  return { initialData, sealedQuery };
}

/** Answers a live route's renewal with a fresh seal of the same query. */
export async function sealedResponse(query: SealableQuery) {
  await assertOwner();
  if (!realtime) return Response.json({ error: "Live updates are off" }, { status: 404 });
  return Response.json(await realtime.seal({ query }), {
    headers: { "Cache-Control": "no-store" },
  });
}

const SESSION_ID = /^[\w.:-]{1,128}$/;
export const parseSessionId = (value: string) =>
  SESSION_ID.test(value) ? value : undefined;

const JOB_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
export const parseJobKey = (value: string) => (JOB_KEY.test(value) ? value : undefined);
