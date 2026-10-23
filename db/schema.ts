import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { STAGES } from "../lib/events";

// Keys equal column names: the Neon Realtime Drizzle adapter requires it.
// Token counters are float8 because int8 and numeric reach live subscribers as strings.

export const runStatus = pgEnum("run_status", ["active", "idle", "ended"]);
export const runStage = pgEnum("run_stage", STAGES);
export const agentStatus = pgEnum("agent_status", [
  "running",
  "completed",
  "failed",
]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

const tokens = () => ({
  input_tokens: doublePrecision("input_tokens").notNull().default(0),
  output_tokens: doublePrecision("output_tokens").notNull().default(0),
  cache_read_tokens: doublePrecision("cache_read_tokens").notNull().default(0),
  cache_write_tokens: doublePrecision("cache_write_tokens")
    .notNull()
    .default(0),
});

export const events = pgTable(
  "events",
  {
    event_id: text("event_id").primaryKey(),
    session_id: text("session_id").notNull(),
    kind: text("kind").notNull(),
    at: ts("at").notNull(),
    // Set on stage events, so an issue's stage history spans every session that worked on it.
    issue_key: text("issue_key"),
    payload: jsonb("payload").notNull(),
  },
  (t) => [
    index("events_session_at_idx").on(t.session_id, t.at),
    index("events_issue_key_idx").on(t.issue_key),
  ],
);

export const runs = pgTable(
  "runs",
  {
    session_id: text("session_id").primaryKey(),
    cwd: text("cwd"),
    repo: text("repo"),
    branch: text("branch"),
    issue_key: text("issue_key"),
    t3_thread_id: text("t3_thread_id"),
    title: text("title"),
    status: runStatus("status").notNull().default("active"),
    stage: runStage("stage"),
    // Stage moves on its own clock: a stage report can land after a later turn_stop.
    stage_at: ts("stage_at"),
    stage_summary: text("stage_summary"),
    question: text("question"),
    pr_url: text("pr_url"),
    transcript_path: text("transcript_path"),
    started_at: ts("started_at").notNull(),
    last_event_at: ts("last_event_at").notNull(),
    model: text("model"),
    ...tokens(),
  },
  (t) => [index("runs_last_event_at_idx").on(t.last_event_at)],
);

export const agents = pgTable(
  "agents",
  {
    tool_use_id: text("tool_use_id").primaryKey(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id").unique(),
    parent_agent_id: text("parent_agent_id"),
    subagent_type: text("subagent_type"),
    description: text("description"),
    model: text("model"),
    status: agentStatus("status").notNull().default("running"),
    started_at: ts("started_at").notNull(),
    ended_at: ts("ended_at"),
    ...tokens(),
  },
  (t) => [index("agents_session_idx").on(t.session_id)],
);

/** One Linear issue the factory claimed. Ingest keeps its stage; the poller owns the rest. */
export const issues = pgTable(
  "issues",
  {
    linear_id: text("linear_id").primaryKey(),
    key: text("key").notNull().unique(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    linear_state: text("linear_state"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    stage: runStage("stage").notNull().default("queued"),
    stage_at: ts("stage_at"),
    stage_summary: text("stage_summary"),
    question: text("question"),
    pr_url: text("pr_url"),
    /** The stage event the issue's stage came from; write-back keys its Linear comment on it. */
    stage_event_id: text("stage_event_id"),
    synced_event_id: text("synced_event_id"),
    /** Ids of every Linear comment the factory posted here; anything else on the issue is a human. */
    factory_comment_ids: jsonb("factory_comment_ids").$type<string[]>().notNull().default([]),
    /** Reply comments already handed to a thread; the replay guard for resumes. */
    delivered_reply_ids: jsonb("delivered_reply_ids").$type<string[]>().notNull().default([]),
    answered_at: ts("answered_at"),
    answer: text("answer"),
    /** The question and answer a relaunched thread gets when the original thread is gone. */
    resume_context: text("resume_context"),
    /** Each retry after a failure is a new attempt on its own branch, with its own budget. */
    attempt: integer("attempt").notNull().default(1),
    /** Why the previous attempt failed; the next attempt's first message quotes it. */
    previous_failure: text("previous_failure"),
    /** When the watchdog nudged a stuck run, and in which stage; cleared once the stage moves on. */
    nudged_at: ts("nudged_at"),
    nudged_stage: runStage("nudged_stage"),
    /** The PR head the factory last sent back to its thread because it conflicted with main. */
    conflict_head: text("conflict_head"),
    t3_thread_id: text("t3_thread_id"),
    session_id: text("session_id"),
    claimed_at: ts("claimed_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [index("issues_claimed_at_idx").on(t.claimed_at)],
);

/** Every webhook delivery, keyed by its id, so a redelivery is recognised and changes nothing. */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  delivery_id: text("delivery_id").primaryKey(),
  source: text("source").notNull(),
  event: text("event").notNull(),
  received_at: ts("received_at").notNull(),
  payload: jsonb("payload").notNull(),
});

export const intentKind = pgEnum("intent_kind", ["claim", "stop", "answer", "merged", "recheck_conflicts"]);

/**
 * What a webhook asks the runner to do. Webhooks only record these; the runner acts on each one
 * through the same idempotent code its timer and startup reconcile use, then sets handled_at.
 */
export const intents = pgTable(
  "intents",
  {
    id: text("id").primaryKey(),
    kind: intentKind("kind").notNull(),
    issue_key: text("issue_key"),
    linear_id: text("linear_id"),
    pr_url: text("pr_url"),
    detail: text("detail"),
    created_at: ts("created_at").notNull(),
    handled_at: ts("handled_at"),
    result: text("result"),
  },
  (t) => [index("intents_open_idx").on(t.handled_at, t.created_at)],
);

export type EventRow = typeof events.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type IntentRow = typeof intents.$inferSelect;
