import "./test-guard";
import assert from "node:assert/strict";
import type { LiveQueryError, LiveQueryState } from "@neon/realtime/client";

const { keepSubscribed } = await import("../runner/realtime");

// A client that, like @neon/realtime's, fails every later subscription once its connection failed.
class FakeClient {
  closed = false;
  failed = false;
  readonly subscriptions: FakeSubscription[] = [];
  subscribe() {
    const subscription = new FakeSubscription(this.failed ? errorState("protocol_error") : { status: "connecting", error: undefined });
    this.subscriptions.push(subscription);
    return subscription;
  }
  close() {
    this.closed = true;
    for (const subscription of this.subscriptions) subscription.set({ status: "closed", error: undefined });
  }
}

class FakeSubscription {
  readonly listeners = new Set<(state: LiveQueryState) => void>();
  constructor(public state: LiveQueryState) {}
  getState = () => this.state;
  onStateChange = (listener: (state: LiveQueryState) => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  set(state: LiveQueryState) {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}

const errorState = (code: string): LiveQueryState => ({
  status: "error",
  error: Object.assign(new Error("protocol error"), { code, retryable: false }) as LiveQueryError,
});

const clients: FakeClient[] = [];
const timers: { run: () => void; ms: number }[] = [];
const logged: Record<string, unknown>[] = [];
let failSubscribe = false;
let connectFailed = false;
const live = keepSubscribed({
  connect: () => {
    const client = new FakeClient();
    client.failed = connectFailed;
    clients.push(client);
    return client;
  },
  subscribe: async (client) => {
    if (failSubscribe) throw new Error("subscribe failed");
    return [client.subscribe(), client.subscribe()];
  },
  log: (detail) => void logged.push(detail),
  schedule: (run, ms) => void timers.push({ run, ms }),
});
const fire = async () => {
  timers.shift()!.run();
  await new Promise((resolve) => setImmediate(resolve));
};

await live.start();
assert.equal(clients.length, 1, "start connects one client");
const [first] = clients;
first!.subscriptions.forEach((s) => s.set({ status: "live", error: undefined }));
first!.subscriptions[0]!.set({ status: "stale", error: undefined });
assert.equal(timers.length, 0, "a stale capability is the library's to renew, not a restart");

// The live runner's failure: the connection fails and both subscriptions error at once.
first!.failed = true;
first!.subscriptions.forEach((s) => s.set(errorState("protocol_error")));
assert.equal(first!.closed, true, "the failed client is closed, so nothing on it lingers");
assert.equal(timers.length, 1, "two errors from one failure schedule one restart");
assert.equal(timers[0]!.ms, 5_000);
await fire();
assert.equal(clients.length, 2, "the restart subscribes on a new client, not the failed one");
assert.deepEqual(
  clients[1]!.subscriptions.map((s) => s.getState().status),
  ["connecting", "connecting"],
  "the new client's subscriptions recover instead of failing at once",
);

// A failed restart backs off, and a live subscription resets the backoff.
failSubscribe = true;
clients[1]!.subscriptions[0]!.set(errorState("connection_lost"));
assert.equal(timers[0]!.ms, 10_000, "a second failure in a row waits longer");
await fire();
assert.equal(timers[0]!.ms, 20_000, "so does a subscribe that throws");
failSubscribe = false;
await fire();
clients.at(-1)!.subscriptions.forEach((s) => s.set({ status: "live", error: undefined }));
clients.at(-1)!.subscriptions[1]!.set(errorState("connection_lost"));
assert.equal(timers[0]!.ms, 5_000, "a live subscription resets the backoff");
await fire();

// A subscription that is already in error when it is returned, before its listener, still restarts.
connectFailed = true;
clients.at(-1)!.subscriptions[0]!.set(errorState("connection_lost"));
await fire();
assert.deepEqual(clients.at(-1)!.subscriptions.map((s) => s.getState().status), ["closed", "closed"]);
assert.equal(timers.length, 1, "an error before the listener is attached schedules a restart");
connectFailed = false;
await fire();
assert.ok(clients.slice(0, -1).every((c) => c.closed), "every replaced client is closed");

live.close();
assert.equal(clients.at(-1)!.closed, true, "close closes the current client");
clients.at(-1)!.subscriptions.forEach((s) => s.set(errorState("protocol_error")));
assert.equal(timers.length, 0, "nothing restarts after close");
assert.ok(logged.some((l) => l.status === "restarting" && l.code === "protocol_error"), "a restart is logged with its cause");

console.log("realtime regressions passed");
