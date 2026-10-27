import { z } from "zod";

// A harness is one T3 provider instance: the agent CLI a factory thread runs on, and the models it offers.

export const DEFAULT_PROVIDER = "claudeAgent";
export const DEFAULT_MODEL = "claude-opus-5-5";

export const harnessSchema = z.object({
  /** The provider instance id, which `t3 thread start --provider` takes. */
  id: z.string(),
  driver: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  models: z.array(z.object({ slug: z.string(), name: z.string() })),
});
export type Harness = z.infer<typeof harnessSchema>;

/** Drivers whose sessions run the factory's hooks and MCP reporter, so stages, cost and the budget cap work. */
export const TRACKED_DRIVERS: readonly string[] = ["claudeAgent"];

/** Drivers without hooks whose factory-report MCP server posts their stages: stages, questions, PRs and assessments, but no cost. */
export const STAGE_REPORTING_DRIVERS: readonly string[] = ["codex"];

/** Usage, cost and the budget cap need `full`; `stages` is the board without cost. */
export type Tracking = "full" | "stages" | "none";

export const isTracked = (providerOrDriver: string) => TRACKED_DRIVERS.includes(providerOrDriver);

export const trackingOf = (providerOrDriver: string): Tracking =>
  isTracked(providerOrDriver) ? "full" : STAGE_REPORTING_DRIVERS.includes(providerOrDriver) ? "stages" : "none";

const DRIVER_LABELS: Record<string, string> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
};

export const harnessLabel = (id: string, driver?: string, displayName?: string | null) =>
  displayName || DRIVER_LABELS[driver ?? id] || DRIVER_LABELS[id] || id;
