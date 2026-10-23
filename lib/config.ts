import { readFileSync } from "node:fs";
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

export function loadConfig(): FactoryConfig {
  return configSchema.parse(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}
