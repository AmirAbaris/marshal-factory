import { z } from "zod";

// What each runner reports about the Mac it runs on, shared by the runner that writes it and the
// panel that parses it back out of the machines row. A collector that fails reports "unknown".

export const UNKNOWN = "unknown";
const known = <T extends z.ZodType>(shape: T) => z.union([shape, z.literal(UNKNOWN)]);
export type Known<T> = T | typeof UNKNOWN;

/** Written every tick; cheap enough to run every 90 s. */
export const heartbeatSchema = z.object({
  cpu: known(z.object({ load1: z.number().nonnegative(), cores: z.number().int().positive() })),
  memory: known(z.object({ usedBytes: z.number().nonnegative(), totalBytes: z.number().positive() })),
  disk: known(z.object({ freeBytes: z.number().nonnegative(), totalBytes: z.number().positive() })),
  capacity: known(z.object({ max: z.number().int().positive(), inFlight: z.number().int().nonnegative() })),
});
export type Heartbeat = z.infer<typeof heartbeatSchema>;

export const CONNECT_STATES = ["linked", "unlinked", UNKNOWN] as const;
export type ConnectState = (typeof CONNECT_STATES)[number];

export const t3ProjectSchema = z.object({
  /** Null when the project was found by probing the CLI, which reports no id. */
  id: z.string().nullable(),
  title: z.string(),
  path: z.string(),
});
export type T3Project = z.infer<typeof t3ProjectSchema>;

/** Read from T3's state database, else probed per factory repo with `t3 thread list`, else unknown. */
export const projectsSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("sqlite"), items: z.array(t3ProjectSchema) }),
  z.object({ source: z.literal("probe"), items: z.array(t3ProjectSchema) }),
  z.object({ source: z.literal(UNKNOWN) }),
]);
export type Projects = z.infer<typeof projectsSchema>;

/** Collected at startup and every inventoryMinutes; written only when it changed. */
export const inventorySchema = z.object({
  runnerSha: known(z.string()),
  t3: known(
    z.object({
      up: z.boolean(),
      version: z.string().nullable(),
      /** The local environment id, the first segment of T3's `t3code://threads/<env>/<thread>` route. */
      environmentId: z.string().nullable(),
    }),
  ),
  connect: z.enum(CONNECT_STATES),
  projects: projectsSchema,
  /** The configured factory repos and their `origin` remote as owner/name. */
  repos: z.array(z.object({ path: z.string(), origin: known(z.string()) })),
});
export type Inventory = z.infer<typeof inventorySchema>;

/** Three missed 90 s ticks. */
export const ONLINE_WINDOW_MS = 270_000;

export const isOnline = (lastSeenAt: Date, now: number) => now - lastSeenAt.getTime() <= ONLINE_WINDOW_MS;

/**
 * The deep link that opens a thread in T3 on the Mac that runs it. T3's desktop app maps
 * `t3code://threads/<environmentId>/<threadId>` to its `/$environmentId/$threadId` route; without
 * an environment id `t3code://app` only brings T3 to the front.
 */
export function t3ThreadLink(threadId: string, environmentId: string | null) {
  return environmentId
    ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
    : "t3code://app";
}
