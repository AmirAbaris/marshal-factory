import { join } from "node:path";

// The factory runner: the only process that touches T3, git and the GitHub API. It reacts to webhook intents
// through Neon Realtime, runs a plain timer for the checks that need no event, and on startup
// reconciles everything it missed while it was down. Every step is idempotent.
//   bun runner/index.ts            run as a daemon (launchd starts it this way)
//   bun runner/index.ts --once     run the startup reconcile once and exit

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");

const { createRealtime } = await import("@neon/realtime/server");
const { drizzleAdapter } = await import("@neon/realtime-drizzle");
const { asc, eq, getTableColumns, isNull } = await import("drizzle-orm");
const { db } = await import("../db/client");
const { intents, jobs } = await import("../db/schema");
const ops = await import("./ops");
const { launchQueued } = await import("./launch");
const { recheckScheduler } = await import("./recheck");
const { everyAtMost, serialQueue } = await import("./queue");
const { stopDeliverable } = await import("./binding");
type IntentRow = typeof intents.$inferSelect;

const log = (event: string, detail: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

const logWorktree = (check: Record<string, unknown>) => log("worktree", check);

const queue = serialQueue(log);
// A backstop: a stray rejection is logged instead of taking the daemon down.
process.on("unhandledRejection", (reason) =>
  log("unhandledRejection", { error: reason instanceof Error ? reason.message : String(reason) }),
);
const serial = queue.serial;

async function handle(intent: IntentRow) {
  // The team is fetched only where Linear is needed, so a Linear outage does not block the rest.
  switch (intent.kind) {
    case "claim": {
      const claimed = await ops.claim();
      await ops.announceClaims();
      return { claimed, launched: await launchQueued(logWorktree) };
    }
    case "stop":
      return { stop: await ops.stopJob(intent.job_id!, intent.detail ?? "stopped in Linear") };
    case "answer":
      return {
        resumed: await ops.resumeAnswered(),
        launched: await launchQueued(logWorktree),
        synced: await ops.writeBack(),
      };
    case "merged":
      return { merged: await ops.checkPullRequests(), synced: await ops.writeBack() };
    case "recheck_conflicts":
      return { recheck: recheck.request() };
  }
}

const recheck = recheckScheduler({
  settled: ops.pullRequestsSettled,
  check: async () => ({ conflicts: await ops.checkPullRequests() }),
  enqueue: (name, step) => void serial(name, step),
  schedule: (run, ms) => void setTimeout(run, ms),
  now: Date.now,
});

const MAX_ATTEMPTS = 50;
const inProgress = new Set<string>();
function takeIntents(rows: readonly IntentRow[]) {
  for (const intent of rows) {
    if (intent.handled_at || inProgress.has(intent.id)) continue;
    // Every later snapshot repeats the open intents; a failed one waits for its retry time.
    if (intent.retry_at && intent.retry_at.getTime() > Date.now()) continue;
    inProgress.add(intent.id);
    // Cleared once the queue is done with the step, even if the step timed out and still runs.
    void serial(`intent:${intent.kind}`, () => runIntent(intent)).finally(() => inProgress.delete(intent.id));
  }
}

async function runIntent(intent: IntentRow) {
  const latencyMs = Date.now() - intent.created_at.getTime();
  const result = await handle(intent).catch((error: unknown) => ({ error: String(error) }));
  // A failed intent stays open and the timer retries it, so a Linear or T3 hiccup cannot eat a
  // stop. After MAX_ATTEMPTS it is closed with the error kept in result.
  const failed = "error" in result;
  const attempts = intent.attempts + 1;
  await db
    .update(intents)
    .set({
      attempts,
      handled_at: failed && attempts < MAX_ATTEMPTS ? null : new Date(),
      // 30 s, 1 min, 2 min, ... then every 30 min: about a day of retries before it gives up.
      retry_at: failed ? new Date(Date.now() + Math.min(30_000 * 2 ** (attempts - 1), 1_800_000)) : null,
      result: JSON.stringify(result).slice(0, 2000),
    })
    .where(eq(intents.id, intent.id));
  return { id: intent.id, job: intent.job_id, latencyMs, attempts, ...result };
}

async function openIntents() {
  return db.select().from(intents).where(isNull(intents.handled_at)).orderBy(asc(intents.created_at));
}

/** Everything a missed webhook could have changed, plus the timer's checks. */
async function reconcile() {
  return {
    ...(await tick()),
    cleaned: await ops.cleanup(),
    launched: await launchQueued(logWorktree),
  };
}

/**
 * The checks that need no event, every tickSeconds. Claiming is here too because a slot frees up
 * without any webhook, and the PR check catches a conflict GitHub settled after a push's recheck.
 */
async function tick() {
  // Each check on its own: one failing (Linear or GitHub down) must not skip the others this tick.
  const each = async <T>(step: () => Promise<T>) =>
    step().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return {
    claimed: await each(async () => {
      const claimed = await ops.claim();
      await ops.announceClaims();
      return claimed;
    }),
    // An answer can land before its question reached Linear, and its intent then finds nothing.
    resumed: await each(ops.resumeAnswered),
    // Stops whose webhook never arrived; before deliverStops, so a new stop is messaged this tick.
    stopsReconciled: await each(() => ops.reconcileStops()),
    stopsDelivered: await each(() => ops.deliverStops()),
    pullRequests: await each(ops.checkPullRequests),
    reconciled: await each(ops.reconcileUsage),
    overBudget: await each(ops.enforceBudget),
    watched: await each(ops.watchdog),
    synced: await each(async () => ops.writeBack()),
  };
}

if (process.argv.includes("--once")) {
  await serial("reconcile", reconcile);
  takeIntents(await openIntents());
  await queue.idle();
  process.exit(0);
}

log("start", { pid: process.pid, tickSeconds: ops.config.factory.tickSeconds });
await serial("reconcile", reconcile);
takeIntents(await openIntents());

const realtime = createRealtime({
  url: process.env.NEON_REALTIME_URL!,
  secret: process.env.NEON_REALTIME_SECRET!,
  db: new URL(process.env.DATABASE_URL!).pathname.slice(1),
  adapter: drizzleAdapter(),
});

/**
 * Realtime does not promise every change, so a snapshot is read as the current state: open
 * intents are taken, and jobs whose stage has not reached their source yet get a write-back.
 */
let resubscribing = false;
async function subscribe() {
  const intentsLive = await realtime.subscribe(
    db.select(getTableColumns(intents)).from(intents).where(isNull(intents.handled_at)).orderBy(asc(intents.created_at)),
  );
  intentsLive.onChange((snapshot) => {
    if (snapshot.status === "live" && snapshot.data) takeIntents(snapshot.data);
  });
  const jobsLive = await realtime.subscribe(db.select(getTableColumns(jobs)).from(jobs));
  jobsLive.onChange((snapshot) => {
    if (snapshot.status !== "live") return;
    const rows = snapshot.data ?? [];
    if (rows.some((i) => i.stage_event_id && i.stage_event_id !== i.synced_event_id)) {
      void serial("writeBack", async () => ops.writeBack());
    }
    // A thread's own session start can bind it (ingest), outside bindThread; deliver its stop now.
    if (rows.some(stopDeliverable)) void serial("deliverStops", () => ops.deliverStops());
  });
  for (const subscription of [intentsLive, jobsLive]) {
    subscription.onStateChange((state) => {
      log("realtime", { status: state.status, error: state.error?.message });
      // An error is final for a subscription; start over once, with fresh ones for both.
      if (state.status === "error" && !resubscribing) {
        resubscribing = true;
        intentsLive.unsubscribe();
        jobsLive.unsubscribe();
        setTimeout(() => {
          resubscribing = false;
          void subscribe().catch((e: unknown) => log("realtime:error", { error: String(e) }));
        }, 5_000);
      }
    });
  }
}
await subscribe();

const hourlyCleanup = everyAtMost(3_600_000, () => ops.cleanup());
setInterval(() => {
  void serial("tick", async () => {
    const result = { ...(await tick()), launched: await launchQueued(logWorktree) };
    const cleaned = await hourlyCleanup();
    return cleaned === undefined ? result : { ...result, cleaned };
  });
  // Intents the subscription may not have delivered.
  void openIntents().then(takeIntents);
}, ops.config.factory.tickSeconds * 1000);

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    log("stop", { signal });
    realtime.close();
    void queue.idle().finally(() => process.exit(0));
  });
}
