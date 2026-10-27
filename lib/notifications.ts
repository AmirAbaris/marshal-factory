import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as schema from "@/db/schema";
import { intents, notificationSettings, type NotificationSettingsRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";

// Where Slack notifications go and which events send one (lib/slack.ts). The panel's Settings
// edits the one row; the runner's notifier reads it every pass. Without a row, a runner with a
// Slack token DMs the owner about every event.
//
// Quiet hours hold back everything but the urgent kinds. Nothing is queued: an event still waiting
// on the owner when quiet hours end is posted then, and one that resolved meanwhile never is.

export const NOTIFICATIONS_ID = "factory";

export const SLACK_TARGETS = ["owner", "channel", "off"] as const;
export type SlackTarget = (typeof SLACK_TARGETS)[number];
export const TARGET_LABELS: Record<SlackTarget, string> = { owner: "Direct message to you", channel: "A channel", off: "Off" };

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 22:00.");

export const validTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const quietHoursSchema = z.object({
  start: timeSchema,
  end: timeSchema,
  timeZone: z.string().trim().refine(validTimeZone, "Unknown time zone."),
});
export type QuietHours = z.infer<typeof quietHoursSchema>;

/** A Slack channel id: public channels start with C, private ones with G or C. */
export const CHANNEL_ID = /^[CG][A-Z0-9]{6,}$/;

const eventsSchema = z
  .object({
    questions: z.boolean().default(true),
    reviews: z.boolean().default(true),
    failures: z.boolean().default(true),
    reverts: z.boolean().default(true),
    stops: z.boolean().default(true),
    merges: z.boolean().default(true),
  })
  .prefault({});

export const notificationConfigSchema = z
  .object({
    target: z.enum(SLACK_TARGETS).default("owner"),
    channelId: z.string().trim().nullable().default(null),
    events: eventsSchema,
    quietHours: quietHoursSchema.nullable().default(null),
  })
  .superRefine((config, ctx) => {
    if (config.target === "channel" && !CHANNEL_ID.test(config.channelId ?? "")) {
      ctx.addIssue({ code: "custom", path: ["channelId"], message: "Enter the channel's id, like C0123456789, from its details in Slack." });
    }
  });
export type NotificationConfig = z.output<typeof notificationConfigSchema>;
export type NotificationInput = z.input<typeof notificationConfigSchema>;

export const DEFAULT_NOTIFICATIONS: NotificationConfig = notificationConfigSchema.parse({});

/** A row that no longer parses falls back to the defaults rather than silencing Slack. */
export const parseNotificationConfig = (value: unknown): NotificationConfig => notificationConfigSchema.safeParse(value ?? {}).data ?? DEFAULT_NOTIFICATIONS;

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether `now` falls in the quiet hours, read on the zone's clock; start equal to end means never. */
export function inQuietHours(quiet: QuietHours | null, now: Date) {
  if (!quiet) return false;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const local = Number(parts.find((p) => p.type === "hour")?.value) * 60 + Number(parts.find((p) => p.type === "minute")?.value);
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  return start < end ? local >= start && local < end : local >= start || local < end;
}

type Db = NodePgDatabase<typeof schema>;

export async function readNotifications(database: Pick<Db, "select">): Promise<NotificationSettingsRow | null> {
  const [row] = await database.select().from(notificationSettings).where(eq(notificationSettings.id, NOTIFICATIONS_ID));
  return row ?? null;
}

export type NotificationDeps = {
  db: Db;
  user: () => Promise<SessionUser | null | undefined>;
  /** Asks Slack about a channel when the panel has a token; null when it can't ask, else why the channel won't do. */
  checkChannel: (channelId: string) => Promise<{ ok: true } | { ok: false; message: string } | null>;
  /** Whether an online runner reports a Slack token. */
  slackConfigured: () => Promise<boolean>;
  now?: () => Date;
};

export type NotificationOutcome = { ok: true; message?: string } | { ok: false; message: string };

const OWNER_ONLY = "Only the factory owner can change notifications.";

export async function saveNotifications(deps: NotificationDeps, input: unknown): Promise<NotificationOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return { ok: false, message: OWNER_ONLY };
  const parsed = notificationConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "The notification settings are not valid." };
  const config = parsed.data;
  let message: string | undefined;
  if (config.target === "channel") {
    const check = await deps.checkChannel(config.channelId!);
    if (check && !check.ok) return check;
    if (!check) message = "Saved. The panel has no Slack token to check the channel; send a test message to be sure.";
  }
  const at = (deps.now ?? (() => new Date()))();
  const values = { config, updated_at: at, updated_by: user.email };
  await deps.db
    .insert(notificationSettings)
    .values({ id: NOTIFICATIONS_ID, ...values })
    .onConflictDoUpdate({ target: notificationSettings.id, set: values });
  return { ok: true, ...(message && { message }) };
}

export const slackTestDetailSchema = z.object({ actor: z.string() });
const requestIdSchema = z.uuid();

/** Records a slack_test intent; a runner with a Slack token posts the test message where notifications go. */
export async function requestSlackTest(deps: NotificationDeps, requestId: string): Promise<{ ok: true; intentId: string } | { ok: false; message: string }> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return { ok: false, message: OWNER_ONLY };
  if (!requestIdSchema.safeParse(requestId).success) return { ok: false, message: "The request is not valid." };
  if (!(await deps.slackConfigured())) return { ok: false, message: "No online runner has a Slack token. Add SLACK_BOT_TOKEN to the runner's .env.local and restart it." };
  const id = `panel:slack_test:${requestId}`;
  await deps.db
    .insert(intents)
    .values({ id, kind: "slack_test", detail: JSON.stringify({ actor: user.email }), created_at: (deps.now ?? (() => new Date()))() })
    .onConflictDoNothing();
  return { ok: true, intentId: id };
}

const testResultSchema = z.object({ error: z.string().optional(), sent: z.object({ to: z.enum(["owner", "channel"]), channel: z.string() }).optional() });

export type SlackTestOutcome = { status: "pending" } | { status: "done"; message: string } | { status: "failed"; message: string };

export async function slackTestOutcome(deps: Pick<NotificationDeps, "db" | "user">, intentId: string): Promise<SlackTestOutcome> {
  if (!isOwner(await deps.user())) return { status: "failed", message: OWNER_ONLY };
  const [intent] = await deps.db.select().from(intents).where(and(eq(intents.id, intentId), eq(intents.kind, "slack_test")));
  if (!intent) return { status: "failed", message: "No such request." };
  const result = testResultSchema.safeParse(intent.result ? JSON.parse(intent.result) : {}).data;
  // A failed try stays open for the retry; say why at once rather than waiting out every try.
  if (result?.error) return { status: "failed", message: `The runner could not send it: ${result.error}` };
  if (!intent.handled_at) return { status: "pending" };
  if (!result?.sent) return { status: "failed", message: "The runner's answer could not be read." };
  return { status: "done", message: result.sent.to === "owner" ? "Sent to your Slack DMs." : `Sent to channel ${result.sent.channel}.` };
}
