import type { LiveQueryState } from "@neon/realtime/client";

export type LiveSubscription = {
  getState(): LiveQueryState;
  onStateChange(listener: (state: LiveQueryState) => void): () => void;
};

export type KeepSubscribedDeps<Client extends { close(): void }> = {
  connect: () => Client;
  /** Subscribes on the client and attaches the change listeners. */
  subscribe: (client: Client) => Promise<readonly LiveSubscription[]>;
  log: (detail: Record<string, unknown>) => void;
  schedule: (run: () => void, ms: number) => void;
};

/**
 * Keeps the runner's live queries subscribed. An error is final for a subscription, and a
 * connection-level failure (such as the server's "protocol error" when a late renewal meets an
 * expired query) is final for the whole client: every later subscribe on it fails at once. So a
 * failure closes the client and starts over on a new one, with backoff, until they are live again.
 */
export function keepSubscribed<Client extends { close(): void }>(
  deps: KeepSubscribedDeps<Client>,
  { baseMs = 5_000, capMs = 60_000 } = {},
) {
  let client: Client | undefined;
  let generation = 0;
  let failures = 0;
  let closed = false;

  const restart = (current: number, reason: Record<string, unknown>) => {
    if (closed || current !== generation) return;
    generation += 1;
    client?.close();
    client = undefined;
    const delayMs = Math.min(baseMs * 2 ** failures, capMs);
    failures += 1;
    deps.log({ status: "restarting", delayMs, ...reason });
    deps.schedule(() => void start(), delayMs);
  };

  const watch = (current: number, state: LiveQueryState) => {
    if (current !== generation) return;
    if (state.status === "live") failures = 0;
    if (state.status === "error") restart(current, { error: state.error.message, code: state.error.code });
  };

  async function start() {
    if (closed) return;
    const current = generation;
    const fresh = deps.connect();
    client = fresh;
    let subscriptions: readonly LiveSubscription[];
    try {
      subscriptions = await deps.subscribe(fresh);
    } catch (error) {
      restart(current, { error: String(error) });
      return;
    }
    for (const subscription of subscriptions) {
      subscription.onStateChange((state) => {
        if (current === generation) deps.log({ status: state.status, error: state.error?.message, code: state.error?.code });
        watch(current, state);
      });
      // A subscription can fail before its listener is attached.
      watch(current, subscription.getState());
    }
  }

  return {
    start,
    close() {
      closed = true;
      generation += 1;
      client?.close();
      client = undefined;
    },
  };
}
