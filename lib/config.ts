import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const CONFIG_PATH = join(homedir(), ".config/marshal-factory/config.json");

/** Every factory limit lives here, with defaults; the config file overrides any of them. */
export const factorySchema = z
  .object({
    teamKey: z.string().default("FAC"),
    label: z.string().default("factory"),
    maxInFlight: z.number().int().positive().default(2),
    /** A working issue with no event for this long, or whose thread stopped, gets one nudge. */
    stuckAfterMinutes: z.number().positive().default(30),
    /** A stopped thread counts as stuck only after this much quiet, so a turn that just ended isn't. */
    stoppedGraceMinutes: z.number().nonnegative().default(2),
    /** After a nudge, this much more quiet marks the issue failed. */
    failAfterNudgeMinutes: z.number().positive().default(30),
    /** USD an issue may spend across all its runs, main sessions plus subagents. */
    budgetUsd: z.number().positive().default(5),
    /** Days a failed issue keeps its worktree for a human to look at before cleanup removes it. */
    cleanupGraceDays: z.number().nonnegative().default(3),
    /** Target repos the factory works in; the installer adds each one. */
    repos: z.array(z.string()).default([]),
    /** Ids of the webhooks scripts/install-webhooks.ts created: `linear`, and one per GitHub repo. */
    webhooks: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  })
  .prefault({});
export type FactoryLimits = z.infer<typeof factorySchema>;

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  ingestUrl: z.url(),
  secret: z.string().min(1),
  factory: factorySchema,
});
export type FactoryConfig = z.infer<typeof configSchema>;

/** Just the limits, for readers that hold no secrets: the panel and the budget hook. */
export function loadLimits(): FactoryLimits {
  const raw = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")).factory : undefined;
  return factorySchema.parse(raw ?? {});
}

export function loadConfig(): FactoryConfig {
  return configSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}
