import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { intents, jobs, slackMessages, type IntentKind, type JobRow, type SlackMessageRow } from "@/db/schema";
import type { SessionUser } from "@/lib/auth/owner";
import { attemptBranch } from "@/lib/factory";
import { followUpHint, MAX_FEEDBACK_CHARS, MAX_FOLLOW_UP_CHARS, type InboxAction } from "@/lib/inbox";
import {
  answerQuestion,
  approveMerge,
  closeJob,
  describeOutcome,
  dismissJob,
  fileFollowUp,
  intentOutcome,
  requestChanges,
  retryStop,
  type InboxDeps,
  type InboxOutcome,
} from "@/lib/inbox-actions";
import { mergeDecisionSchema } from "@/lib/merge-decision";
import { ITEM_BLOCK_PREFIX, notifyEvents, PENDING_LABELS, redact, renderMessage, slackAction, SLACK_ACTION_IDS, type MessageFacts, type NotifyEvent } from "@/lib/slack";
import type { SlackClient } from "@/lib/slack-api";
import { branchCosts } from "@/lib/spend";

// Acting from Slack: the interactivity route (app/api/slack/interactions) hands every request here.
// A click on an open message's button, or a modal's submission, runs the same inbox action the
// panel runs (lib/inbox-actions.ts) as the owner, so Slack is one more front door to the same
// intents and the runner does the rest. Only the Slack user SLACK_OWNER_USER_ID names may act.
// Slack wants an answer within 3 seconds, so the route acks and the work runs after it.

/** Slack signs each request; one older than this is a replay. */
export const MAX_SKEW_SECONDS = 5 * 60;

export const NOT_OWNER = "Only the factory owner can act from Slack.";
export const ALREADY_RESOLVED = "This is already resolved; nothing was done.";
const NO_TOKEN = "The panel has no SLACK_BOT_TOKEN, so it can't act from Slack.";

/** Checks `X-Slack-Signature`: v0, HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the signing secret. */
export function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowMs: number) {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The owner as the inbox actions check it: the first address in FACTORY_OWNER_EMAILS, which a Slack click by SLACK_OWNER_USER_ID stands for. */
export function ownerFromAllowlist(allowlist = process.env.FACTORY_OWNER_EMAILS): SessionUser | null {
  const email = allowlist?.split(",")[0]?.trim();
  return email ? { email, emailVerified: true } : null;
}

/**
 * The request id of one attempt at one action on one event: a double click, a second modal or a
 * Slack retry gets the same one, so it records one intent, files one issue or posts one answer; a
 * UUID, as the inbox actions want. `after` is the request id of the attempt the runner refused.
 */
export function slackRequestId(eventId: string, action: InboxAction, after = "") {
  const h = createHash("sha256").update(`slack:${eventId}:${action}${after && `:${after}`}`).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The intent each runner-handled action records, keyed panel:<kind>:<request id>. */
const INTENT_KINDS = {
  answer: "answer",
  approve: "approve_merge",
  request_changes: "request_changes",
  close: "close_job",
  retry_stop: "retry_stop",
} as const satisfies Partial<Record<InboxAction, IntentKind>>;

/**
 * The request id for this click: the first attempt's, or the one after the last attempt the runner
 * refused, so the action can be tried again however the message was rendered since. Clicks while
 * an attempt is pending or done get that attempt's id and record nothing new.
 */
async function nextRequestId(deps: InteractionDeps, eventId: string, action: InboxAction) {
  let id = slackRequestId(eventId, action);
  if (!(action in INTENT_KINDS)) return id;
  const kind = INTENT_KINDS[action as keyof typeof INTENT_KINDS];
  for (;;) {
    const [intent] = await deps.inbox.db.select().from(intents).where(eq(intents.id, `panel:${kind}:${id}`));
    if (!intent?.handled_at || describeOutcome(kind, intent.result).status !== "failed") return id;
    id = slackRequestId(eventId, action, id);
  }
}

const MODAL_ACTIONS = ["answer", "request_changes", "follow_up", "close"] as const satisfies readonly InboxAction[];
type ModalAction = (typeof MODAL_ACTIONS)[number];
const isModal = (action: InboxAction): action is ModalAction => (MODAL_ACTIONS as readonly string[]).includes(action);

/** The modal's one input. */
export const TEXT_BLOCK = "text";
const TEXT_ACTION = "text";
/** Slack's limit for a plain text input. */
const SLACK_INPUT_MAX = 3000;

const MODAL_TITLES: Record<ModalAction, string> = {
  answer: "Answer",
  request_changes: "Request changes",
  follow_up: "File a follow-up",
  close: "Close the job",
};

type ModalCopy = { title: string; label: string; hint: string; submit: string; optional: boolean; max: number };

function modalCopy(action: ModalAction, job: JobRow): ModalCopy {
  const title = MODAL_TITLES[action];
  switch (action) {
    case "answer":
      return { title, label: "Your answer", hint: "Posted on the issue as your reply; the agent resumes with it.", submit: "Send answer", optional: false, max: MAX_FEEDBACK_CHARS };
    case "request_changes":
      return { title, label: "What should change", hint: "Sent to the agent, which updates the same branch and PR.", submit: "Request changes", optional: false, max: MAX_FEEDBACK_CHARS };
    case "follow_up":
      return {
        title,
        label: "What the fix should do",
        hint: "Filed as a new issue with the failed checks, the merged PR and why the revert failed; the factory picks it up as a new job.",
        submit: "File a follow-up",
        optional: false,
        max: MAX_FOLLOW_UP_CHARS,
      };
    case "close":
      return {
        title,
        label: "Reason (optional)",
        hint:
          job.stage === "failed"
            ? "Closes the pull request if it is still open and takes the job out of the inbox."
            : "Closes the pull request without merging, stops the agent and marks the job failed. Adding the factory label again retries it as a new attempt.",
        submit: "Close the job",
        optional: true,
        max: 2000,
      };
    default: {
      const never: never = action;
      throw new Error(`unknown modal action ${String(never)}`);
    }
  }
}

const metadataSchema = z.object({ event: z.string(), responseUrl: z.string() });

/** A modal with only a note and no submit: what the click opens at once, and what it becomes if there is nothing to fill in. */
export function noteModal(action: ModalAction, text: string) {
  return {
    type: "modal",
    callback_id: SLACK_ACTION_IDS[action],
    title: { type: "plain_text", text: MODAL_TITLES[action] },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "plain_text", text } }],
  };
}
export const LOADING = "Loading…";

export function renderModal(action: ModalAction, item: Item, facts: MessageFacts, responseUrl: string) {
  const { job, event } = item;
  const copy = modalCopy(action, job);
  const clean = (text: string) => redact(text, facts.secrets).replace(/\s+/g, " ").trim().slice(0, 2000);
  const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const initial = action === "follow_up" ? followUpHint(job, mergeDecisionSchema.safeParse(job.merge_decision).data ?? null) : undefined;
  return {
    type: "modal",
    callback_id: SLACK_ACTION_IDS[action],
    private_metadata: JSON.stringify({ event: event.id, responseUrl } satisfies z.infer<typeof metadataSchema>),
    title: { type: "plain_text", text: copy.title },
    submit: { type: "plain_text", text: copy.submit },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${escape(job.key)} · ${escape(clean(job.title))}*\n${escape(clean(event.reason))}` } },
      {
        type: "input",
        block_id: TEXT_BLOCK,
        optional: copy.optional,
        label: { type: "plain_text", text: copy.label },
        hint: { type: "plain_text", text: copy.hint },
        element: {
          type: "plain_text_input",
          action_id: TEXT_ACTION,
          multiline: true,
          max_length: Math.min(copy.max, SLACK_INPUT_MAX),
          ...(initial && { initial_value: initial }),
        },
      },
    ],
  };
}

export type InteractionDeps = {
  signingSecret: string | undefined;
  /** The Slack member id of the only user who may act. */
  ownerSlackId: string | undefined;
  slack: Pick<SlackClient, "update" | "openView" | "updateView"> | null;
  /** Posts to a click's response_url. */
  respond: (url: string, body: object) => Promise<void>;
  /** The inbox actions' deps, acting as the owner. */
  inbox: InboxDeps;
  panelUrl: string;
  secrets: readonly string[];
  /** Runs work after the ack; next/server's after in the route. */
  after: (task: () => Promise<void>) => void;
  now?: () => number;
  /** How often, and how long, an action follows its intent; once it stops following, the notifier has the last word. */
  pollMs?: number;
  followMs?: number;
};

type Item = { row: SlackMessageRow & { channel: string; ts: string }; job: JobRow; event: NotifyEvent<JobRow> };

/** The open message and the event it is about, while that event is still open; null once it resolved or changed. */
async function openItem(deps: InteractionDeps, eventId: string): Promise<Item | null> {
  const [row] = await deps.inbox.db.select().from(slackMessages).where(eq(slackMessages.id, eventId));
  if (!row || row.state !== "open" || !row.channel || !row.ts) return null;
  const [job] = await deps.inbox.db.select().from(jobs).where(eq(jobs.id, row.job_id));
  const event = job ? notifyEvents([job]).find((e) => e.id === row.id && e.open) : undefined;
  return event ? { row: { ...row, channel: row.channel, ts: row.ts }, job: job!, event } : null;
}

async function messageFacts(deps: InteractionDeps, job: JobRow): Promise<MessageFacts> {
  const branch = attemptBranch(job.key, job.attempt);
  const costs = await branchCosts(deps.inbox.db, [branch]);
  return { panelUrl: deps.panelUrl, spend: costs[branch] ?? null, secrets: deps.secrets };
}

/** What may be shown of an unexpected error: its message, redacted, never a stack. */
const safeMessage = (deps: InteractionDeps, error: unknown) =>
  `Something went wrong: ${redact(error instanceof Error ? error.message : String(error), deps.secrets).slice(0, 300)}`;

function runAction(inbox: InboxDeps, action: InboxAction, job: JobRow, requestId: string, text: string): Promise<InboxOutcome> {
  switch (action) {
    case "answer":
      return answerQuestion(inbox, job.id, requestId, text);
    case "approve": {
      const decision = mergeDecisionSchema.safeParse(job.merge_decision).data;
      return approveMerge(inbox, job.id, requestId, decision?.review?.headSha ?? decision?.headSha ?? null);
    }
    case "request_changes":
      return requestChanges(inbox, job.id, requestId, text);
    case "follow_up":
      return fileFollowUp(inbox, job.id, requestId, text);
    case "close":
      return closeJob(inbox, job.id, requestId, text);
    case "dismiss":
      return dismissJob(inbox, job.id);
    case "retry_stop":
      return retryStop(inbox, job.id, requestId);
    default: {
      const never: never = action;
      throw new Error(`unknown inbox action ${String(never)}`);
    }
  }
}

/** Follows the intent until the runner handled it, as the panel's detail pane does. */
async function follow(deps: InteractionDeps, intentId: string): Promise<InboxOutcome> {
  const pollMs = deps.pollMs ?? 2_000;
  const deadline = Date.now() + (deps.followMs ?? 50_000);
  for (;;) {
    const outcome = await intentOutcome(deps.inbox, intentId);
    if (outcome.status === "failed") return { ok: false, message: outcome.message };
    if (outcome.status === "done") return { ok: true, intentId };
    if (Date.now() + pollMs > deadline) return { ok: true, intentId };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Shows the pending state, runs the action and follows its intent. A refusal puts the buttons back
 * and says why; otherwise the notifier edits the message to its resolution.
 */
async function act(deps: InteractionDeps, item: Item, action: InboxAction, text: string, reply: (text: string) => Promise<void>) {
  const facts = await messageFacts(deps, item.job);
  const show = async (pending: string | null) => {
    try {
      await deps.slack?.update(item.row.channel, item.row.ts, renderMessage(item.event, facts, null, pending));
    } catch (error) {
      console.error(`slack: update ${item.row.id} failed: ${safeMessage(deps, error)}`);
    }
  };
  await show(PENDING_LABELS[action]);
  let outcome: InboxOutcome;
  try {
    outcome = await runAction(deps.inbox, action, item.job, await nextRequestId(deps, item.event.id, action), text);
    if (outcome.ok && outcome.intentId) outcome = await follow(deps, outcome.intentId);
  } catch (error) {
    outcome = { ok: false, message: safeMessage(deps, error) };
  }
  if (!outcome.ok) {
    await show(null);
    await reply(outcome.message);
  } else if (outcome.message) {
    await reply(outcome.message);
  }
}

const userSchema = z.object({ id: z.string() });
const blockActionsSchema = z.object({
  type: z.literal("block_actions"),
  user: userSchema,
  trigger_id: z.string(),
  response_url: z.string(),
  actions: z.array(z.object({ action_id: z.string(), block_id: z.string() })),
});
const viewSubmissionSchema = z.object({
  type: z.literal("view_submission"),
  user: userSchema,
  view: z.object({
    callback_id: z.string(),
    private_metadata: z.string(),
    state: z.object({ values: z.record(z.string(), z.record(z.string(), z.object({ value: z.string().nullish() }))) }),
  }),
});

const ack = () => new Response(null, { status: 200 });
/** A note only the clicker sees; the reason can quote what an agent or a source wrote, so it is redacted too. */
const ephemeral = (deps: InteractionDeps, text: string) => ({ response_type: "ephemeral", replace_original: false, text: redact(text, deps.secrets) });
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Every request Slack sends to the interactivity URL. The signature is checked before anything is read. */
export async function handleInteraction(request: Request, deps: InteractionDeps): Promise<Response> {
  const body = await request.text();
  const now = deps.now?.() ?? Date.now();
  if (!verifySignature(deps.signingSecret ?? "", request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), body, now)) {
    return new Response("invalid signature", { status: 401 });
  }
  const payload = parseJson(new URLSearchParams(body).get("payload") ?? "");
  const isOwner = (user: { id: string }) => !!deps.ownerSlackId && user.id === deps.ownerSlackId;

  const click = blockActionsSchema.safeParse(payload);
  if (click.success) return clicked(deps, click.data, isOwner(click.data.user));
  const submission = viewSubmissionSchema.safeParse(payload);
  if (submission.success) return submitted(deps, submission.data, isOwner(submission.data.user));
  // Clicks on link buttons, closed modals and anything else Slack sends need only the ack.
  return ack();
}

async function clicked(deps: InteractionDeps, payload: z.infer<typeof blockActionsSchema>, owner: boolean) {
  const [button] = payload.actions;
  const action = button ? slackAction(button.action_id) : null;
  if (!button || !action) return ack();
  const reply = (text: string) => deps.respond(payload.response_url, ephemeral(deps, text));
  const slack = owner ? deps.slack : null;
  // The trigger id expires 3 seconds after the click, so a modal opens before the ack and before any
  // read; the item is filled in afterwards.
  let view: { id: string; hash?: string } | null = null;
  let openError: unknown = null;
  if (slack && isModal(action)) {
    try {
      view = await slack.openView(payload.trigger_id, noteModal(action, LOADING));
    } catch (error) {
      openError = error;
    }
  }
  deps.after(async () => {
    try {
      if (!owner) return await reply(NOT_OWNER);
      if (!slack) return await reply(NO_TOKEN);
      if (openError) throw openError;
      const read = () => (button.block_id.startsWith(ITEM_BLOCK_PREFIX) ? openItem(deps, button.block_id.slice(ITEM_BLOCK_PREFIX.length)) : null);
      if (view && isModal(action)) {
        try {
          const item = await read();
          const next = item ? renderModal(action, item, await messageFacts(deps, item.job), payload.response_url) : noteModal(action, ALREADY_RESOLVED);
          await slack.updateView(view.id, next, view.hash);
        } catch (error) {
          await slack.updateView(view.id, noteModal(action, safeMessage(deps, error))).catch(() => undefined);
          throw error;
        }
        return;
      }
      const item = await read();
      if (!item) return await reply(ALREADY_RESOLVED);
      await act(deps, item, action, "", reply);
    } catch (error) {
      await reply(safeMessage(deps, error)).catch(() => undefined);
    }
  });
  return ack();
}

/** A modal's submission: refused inline while the modal is open, else acked (which closes it) and acted on. */
async function submitted(deps: InteractionDeps, payload: z.infer<typeof viewSubmissionSchema>, owner: boolean) {
  const action = slackAction(payload.view.callback_id);
  if (!action) return ack();
  const refuse = (message: string) => Response.json({ response_action: "errors", errors: { [TEXT_BLOCK]: message } });
  if (!owner) return refuse(NOT_OWNER);
  const meta = metadataSchema.safeParse(parseJson(payload.view.private_metadata));
  if (!meta.success) return refuse("This form can't be read; open it again from the message.");
  const item = await openItem(deps, meta.data.event);
  if (!item) return refuse(ALREADY_RESOLVED);
  const text = payload.view.state.values[TEXT_BLOCK]?.[TEXT_ACTION]?.value ?? "";
  const reply = (message: string) => deps.respond(meta.data.responseUrl, ephemeral(deps, message));
  deps.after(async () => {
    try {
      await act(deps, item, action, text, reply);
    } catch (error) {
      await reply(safeMessage(deps, error)).catch(() => undefined);
    }
  });
  return ack();
}
