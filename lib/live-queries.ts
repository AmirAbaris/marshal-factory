import { createRealtime } from "@neon/realtime/server";
import { drizzleAdapter } from "@neon/realtime-drizzle";
import { and, asc, desc, eq, getTableColumns, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, events, issues, runs } from "@/db/schema";

// v0 has no auth: the panel is local and single-user. Phase 7 puts a session check in front of
// every route that calls seal(); until then anyone who can reach these routes can read all rows.

export const realtime = createRealtime({
  secret: process.env.NEON_REALTIME_SECRET!,
  db: new URL(process.env.DATABASE_URL!).pathname.slice(1),
  adapter: drizzleAdapter(),
});

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

export const ISSUE_LIMIT = 200;

export const issuesQuery = () =>
  db
    .select(getTableColumns(issues))
    .from(issues)
    .orderBy(desc(issues.claimed_at))
    .limit(ISSUE_LIMIT);

export const STAGE_HISTORY_LIMIT = 100;

export const sessionStagesQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.session_id, sessionId), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

/** Every stage report for an issue, across all the sessions that worked on it. */
export const issueStagesQuery = (issueKey: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.issue_key, issueKey), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

export async function runIssueKey(sessionId: string) {
  const [row] = await db
    .select({ issueKey: runs.issue_key })
    .from(runs)
    .where(eq(runs.session_id, sessionId));
  return row?.issueKey ?? undefined;
}

/** Runs the query for server rendering and seals it for the browser subscription. */
export async function load<Q extends Parameters<typeof realtime.seal>[0]["query"]>(
  query: Q,
) {
  const [initialData, sealedQuery] = await Promise.all([
    query,
    realtime.seal({ query }),
  ]);
  return { initialData, sealedQuery };
}

export function sealOnly(query: Parameters<typeof realtime.seal>[0]["query"]) {
  return realtime.seal({ query });
}

const SESSION_ID = /^[\w.:-]{1,128}$/;
export const parseSessionId = (value: string) =>
  SESSION_ID.test(value) ? value : undefined;

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
export const parseIssueKey = (value: string) => (ISSUE_KEY.test(value) ? value : undefined);
