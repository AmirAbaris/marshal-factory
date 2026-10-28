import type { SlackMessage } from "./slack";

// The few Slack Web API methods the factory calls, over fetch. One call at a time per client, with
// a gap between calls, so a burst of events stays under Slack's per-method limits. A 429 waits out
// Retry-After when it is short; a longer one pauses the client, and every call until then throws
// SlackRateLimited without reaching Slack. Errors name the method and Slack's error code, never the token.

export const SLACK_API_URL = "https://slack.com/api/";

export class SlackApiError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export class SlackRateLimited extends Error {
  constructor(readonly until: number) {
    super(`Slack is rate limiting the factory until ${new Date(until).toISOString()}`);
  }
}

export type SlackClientOptions = {
  token: string;
  /** The fake server's URL in the regressions; Slack's otherwise. */
  baseUrl?: string;
  minGapMs?: number;
  /** The longest Retry-After a call waits out itself; a longer one pauses the client. */
  maxWaitMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type SlackClient = ReturnType<typeof slackClient>;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function slackClient({ token, baseUrl = SLACK_API_URL, minGapMs = 1_000, maxWaitMs = 10_000, retries = 2, sleep = wait, now = Date.now }: SlackClientOptions) {
  let chain: Promise<unknown> = Promise.resolve();
  let lastCallAt = 0;
  let pausedUntil = 0;

  async function send(method: string, params: Record<string, string>, timeoutMs: number): Promise<Record<string, unknown>> {
    for (let attempt = 0; ; attempt++) {
      if (now() < pausedUntil) throw new SlackRateLimited(pausedUntil);
      const gap = lastCallAt + minGapMs - now();
      if (gap > 0) await sleep(gap);
      lastCallAt = now();
      const response = await fetch(new URL(method, baseUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 429) {
        const seconds = Number(response.headers.get("retry-after"));
        const waitMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1_000;
        if (waitMs > maxWaitMs || attempt >= retries) {
          pausedUntil = now() + waitMs;
          throw new SlackRateLimited(pausedUntil);
        }
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) throw new SlackApiError(method, `http_${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      if (body.ok !== true) throw new SlackApiError(method, typeof body.error === "string" ? body.error : "unknown_error");
      return body;
    }
  }

  function call(method: string, params: Record<string, string>, timeoutMs = 15_000) {
    const result = chain.then(() => send(method, params, timeoutMs));
    chain = result.catch(() => undefined);
    return result;
  }

  const messageParams = ({ text, blocks }: SlackMessage) => ({ text, blocks: JSON.stringify(blocks), unfurl_links: "false", unfurl_media: "false" });
  const str = (value: unknown, what: string) => {
    if (typeof value !== "string") throw new Error(`Slack returned no ${what}`);
    return value;
  };

  return {
    /** Posts a message, as a reply in the thread of `threadTs` when given. */
    async postMessage(channel: string, message: SlackMessage, threadTs?: string) {
      const body = await call("chat.postMessage", { channel, ...messageParams(message), ...(threadTs && { thread_ts: threadTs }) });
      return { channel: str(body.channel, "channel"), ts: str(body.ts, "ts") };
    },
    async update(channel: string, ts: string, message: SlackMessage) {
      await call("chat.update", { channel, ts, ...messageParams(message) });
    },
    /** The DM channel with a user; chat.update needs its id, not the user's. */
    async openDm(user: string) {
      const body = await call("conversations.open", { users: user });
      return str((body.channel as { id?: unknown } | undefined)?.id, "channel id");
    },
    /** Opens a modal; the trigger id from a click is good for 3 seconds. Returns the view's id and hash for updateView. */
    async openView(triggerId: string, view: object) {
      const body = await call("views.open", { trigger_id: triggerId, view: JSON.stringify(view) });
      const opened = body.view as { id?: unknown; hash?: unknown } | undefined;
      return { id: str(opened?.id, "view id"), hash: typeof opened?.hash === "string" ? opened.hash : undefined };
    },
    /** Replaces an open modal; with the hash, Slack refuses the update if the view changed since. */
    async updateView(viewId: string, view: object, hash?: string) {
      await call("views.update", { view_id: viewId, view: JSON.stringify(view), ...(hash && { hash }) });
    },
    /** A link to a message; it needs no scope beyond the token. */
    async permalink(channel: string, ts: string, timeoutMs?: number) {
      const body = await call("chat.getPermalink", { channel, message_ts: ts }, timeoutMs);
      return str(body.permalink, "permalink");
    },
    pausedUntil: () => pausedUntil,
  };
}

/** Replies through a click's response_url, which needs no token: an ephemeral note, or a replacement of the message. */
export async function postResponse(url: string, body: object) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new SlackApiError("response_url", `http_${response.status}`);
}
