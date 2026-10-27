import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lt, or } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, slackMessages, type JobRow } from "../db/schema";
import { loadConfig } from "../lib/config";
import { attemptBranch } from "../lib/factory";
import { inQuietHours, parseNotificationConfig, readNotifications, slackTestDetailSchema, type NotificationConfig, type SlackTarget } from "../lib/notifications";
import { NOTIFY_WINDOW_MS, notifyEvents, renderMessage, renderTest, resolution, TOGGLE_OF, URGENT, type MessageFacts, type SlackMessage } from "../lib/slack";
import { SlackApiError, slackClient, SlackRateLimited, type SlackClient } from "../lib/slack-api";
import { branchCosts } from "../lib/spend";

// The Slack notifier: each pass diffs the notification events (lib/slack.ts) against the
// slack_messages rows, resolves the messages whose event went away, edits the ones whose event
// changed and posts the new ones. Every step is keyed by the event id, so a re-tick, a restart or a
// second runner never posts an event twice. A runner without SLACK_BOT_TOKEN does nothing.

export const panelUrl = () => (process.env.FACTORY_PANEL_URL ?? "https://marshal-factory.vercel.app").replace(/\/+$/, "");

/** Most Slack calls one pass makes; the rest wait for the next tick, so Slack never holds up the runner's queue. */
export const MAX_CALLS_PER_PASS = 25;
/** A row still posting after this belongs to a runner that died mid-post; the event is posted again. */
export const POSTING_STALE_MS = 5 * 60_000;

/** Environment variables whose values must never reach Slack, whatever an agent writes. */
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|DATABASE_URL)/i;

export type SlackSetup = { client: SlackClient; owner: string | null; secrets: readonly string[] };

let cached: { key: string; client: SlackClient } | undefined;

/** The Slack client for this runner's env; one per token, so a pause for Retry-After holds across passes. */
export function slackFromEnv(env: Record<string, string | undefined> = process.env): SlackSetup | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = env.SLACK_API_URL?.trim() || undefined;
  const key = createHash("sha256").update(`${token}\n${baseUrl ?? ""}`).digest("hex");
  if (cached?.key !== key) cached = { key, client: slackClient({ token, baseUrl }) };
  const secrets = Object.entries(env).flatMap(([name, value]) => (value && SECRET_NAME.test(name) ? [value] : []));
  return { client: cached.client, owner: env.SLACK_OWNER_USER_ID?.trim() || null, secrets };
}

const dmChannels = new Map<string, string>();

type Destination = { channel: string; to: Exclude<SlackTarget, "off"> };

async function destination(target: SlackTarget, config: NotificationConfig, slack: SlackSetup): Promise<Destination | string> {
  switch (target) {
    case "owner": {
      if (!slack.owner) return "SLACK_OWNER_USER_ID is not set on this runner";
      let channel = dmChannels.get(slack.owner);
      if (!channel) {
        channel = await slack.client.openDm(slack.owner);
        dmChannels.set(slack.owner, channel);
      }
      return { channel, to: "owner" };
    }
    case "channel":
      return config.channelId ? { channel: config.channelId, to: "channel" } : "no channel is set";
    case "off":
      return "notifications are off";
    default: {
      const never: never = target;
      throw new Error(`unknown Slack target ${String(never)}`);
    }
  }
}

const fingerprint = (message: SlackMessage) => createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 32);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type NotifyResult =
  | "disabled"
  | { posted: number; updated: number; resolved: number; held: number; errors?: string[]; rateLimitedUntil?: string; deferred?: true };

export async function notifySlack(slack: SlackSetup | null = slackFromEnv(), now = new Date()): Promise<NotifyResult> {
  if (!slack) return "disabled";
  const config = parseNotificationConfig((await readNotifications(db))?.config);
  await db.delete(slackMessages).where(and(eq(slackMessages.state, "posting"), lt(slackMessages.created_at, new Date(now.getTime() - POSTING_STALE_MS))));

  // Recent jobs for new events, and every job with an open message, however old, to see if it resolved.
  const cutoff = new Date(now.getTime() - 2 * NOTIFY_WINDOW_MS);
  const openJobs = db.select({ id: slackMessages.job_id }).from(slackMessages).where(eq(slackMessages.state, "open"));
  const loaded = await db.select().from(jobs).where(or(gt(jobs.updated_at, cutoff), gt(jobs.stage_at, cutoff), inArray(jobs.id, openJobs)));
  const events = notifyEvents(loaded);
  const eventOf = new Map(events.map((e) => [e.id, e]));
  const rows = await db
    .select()
    .from(slackMessages)
    .where(events.length > 0 ? or(eq(slackMessages.state, "open"), inArray(slackMessages.id, [...eventOf.keys()])) : eq(slackMessages.state, "open"));
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobOf = new Map(loaded.map((j) => [j.id, j]));

  const branchOf = (job: Pick<JobRow, "key" | "attempt">) => attemptBranch(job.key, job.attempt);
  const costs = await branchCosts(db, [...new Set([...events.map((e) => branchOf(e.job)), ...rows.flatMap((r) => (jobOf.has(r.job_id) ? [branchOf(jobOf.get(r.job_id)!)] : []))])], loadConfig().factory.pricing);
  const facts = (job: JobRow): MessageFacts => ({ panelUrl: panelUrl(), spend: costs[branchOf(job)] ?? null, secrets: slack.secrets });

  const result = { posted: 0, updated: 0, resolved: 0, held: 0 };
  const errors: string[] = [];
  let calls = 0;
  const budget = () => calls < MAX_CALLS_PER_PASS;

  try {
    // Resolutions first: a stale "needs you" is worse than a late new one.
    for (const row of rows) {
      if (!budget()) break;
      if (row.state !== "open" || eventOf.get(row.id)?.open) continue;
      const job = jobOf.get(row.job_id);
      const text = resolution(row.kind, job);
      const message = job ? renderMessage({ id: row.id, kind: row.kind, job, reason: "" }, facts(job), text) : null;
      try {
        if (message && row.channel && row.ts) {
          calls++;
          await slack.client.update(row.channel, row.ts, message);
        }
        await db
          .update(slackMessages)
          .set({ state: "resolved", resolution: text, resolved_at: now, updated_at: now, ...(message && { fingerprint: fingerprint(message) }) })
          .where(and(eq(slackMessages.id, row.id), eq(slackMessages.state, "open")));
        result.resolved++;
      } catch (error) {
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`resolve ${row.id}: ${errorText(error)}`);
      }
    }

    // Open events whose message changed, or came back after it was resolved (a merge GitHub refused).
    for (const event of events) {
      if (!budget()) break;
      const row = rowOf.get(event.id);
      if (!event.open || !row || row.state === "posting" || !row.channel || !row.ts) continue;
      const message = renderMessage(event, facts(event.job));
      const print = fingerprint(message);
      if (row.state === "open" && row.fingerprint === print) continue;
      try {
        calls++;
        await slack.client.update(row.channel, row.ts, message);
        await db
          .update(slackMessages)
          .set({ state: "open", fingerprint: print, resolution: null, resolved_at: null, updated_at: now })
          .where(eq(slackMessages.id, event.id));
        result.updated++;
      } catch (error) {
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`update ${event.id}: ${errorText(error)}`);
      }
    }

    const quiet = inQuietHours(config.quietHours, now);
    let target: Destination | string | undefined;
    for (const event of events) {
      if (rowOf.has(event.id) || !config.events[TOGGLE_OF[event.kind]]) continue;
      if (now.getTime() - event.at.getTime() > NOTIFY_WINDOW_MS) continue;
      if (quiet && !URGENT[event.kind]) {
        result.held++;
        continue;
      }
      if (!budget()) break;
      target ??= await destination(config.target, config, slack);
      if (typeof target === "string") {
        if (config.target !== "off") errors.push(`post: ${target}`);
        break;
      }
      const [claimed] = await db
        .insert(slackMessages)
        .values({ id: event.id, job_id: event.job.id, kind: event.kind, state: "posting", created_at: now, updated_at: now })
        .onConflictDoNothing()
        .returning({ id: slackMessages.id });
      if (!claimed) continue;
      const message = renderMessage(event, facts(event.job));
      try {
        calls++;
        const posted = await slack.client.postMessage(target.channel, message);
        await db
          .update(slackMessages)
          .set({
            state: event.open ? "open" : "resolved",
            channel: posted.channel,
            ts: posted.ts,
            fingerprint: fingerprint(message),
            resolution: event.open ? null : resolution(event.kind, event.job),
            resolved_at: event.open ? null : now,
            updated_at: now,
          })
          .where(eq(slackMessages.id, event.id));
        result.posted++;
      } catch (error) {
        await db.delete(slackMessages).where(and(eq(slackMessages.id, event.id), eq(slackMessages.state, "posting")));
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`post ${event.id}: ${errorText(error)}`);
        // A bad channel or a revoked token fails every post the same way; try again next pass.
        if (error instanceof SlackApiError) break;
      }
    }
  } catch (error) {
    if (!(error instanceof SlackRateLimited)) throw error;
    return { ...result, ...(errors.length > 0 && { errors }), rateLimitedUntil: new Date(error.until).toISOString() };
  }
  return { ...result, ...(errors.length > 0 && { errors }), ...(!budget() && { deferred: true as const }) };
}

/** The slack_test intent: posts a test message where notifications go, or to the owner's DMs while they are off. */
export async function sendSlackTest(detail: unknown, slack: SlackSetup | null = slackFromEnv()) {
  if (!slack) return { error: "this runner has no SLACK_BOT_TOKEN" };
  const { actor } = slackTestDetailSchema.parse(detail);
  const config = parseNotificationConfig((await readNotifications(db))?.config);
  const target = await destination(config.target === "off" ? "owner" : config.target, config, slack);
  if (typeof target === "string") return { error: target };
  const posted = await slack.client.postMessage(target.channel, renderTest(actor));
  return { sent: { to: target.to, channel: posted.channel } };
}
