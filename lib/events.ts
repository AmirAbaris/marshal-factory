import { z } from "zod";

export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  model: z.string(),
});
export type Usage = z.infer<typeof usageSchema>;

export const STAGES = [
  "queued",
  "triage",
  "investigating",
  "implementing",
  "verifying",
  "pr",
  "waiting",
  "merged",
  "failed",
] as const;
export const stageSchema = z.enum(STAGES);
export type Stage = z.infer<typeof stageSchema>;

/** What a factory thread passes to `report_stage`; the hook re-parses the same shape from tool_input. */
export const stageReportShape = {
  stage: stageSchema.describe("The stage the run just entered."),
  summary: z
    .string()
    .min(1)
    .max(500)
    .describe("One or two sentences on what happened. For failed, the reason."),
  prUrl: z.url().optional().describe("Required for stage pr: the pull request URL."),
  question: z
    .string()
    .min(1)
    .max(2000)
    .optional()
    .describe("Required for stage waiting: the concrete question the human must answer."),
};
export const stageReportSchema = z
  .object(stageReportShape)
  .refine((r) => r.stage !== "pr" || r.prUrl, { message: "stage pr needs prUrl", path: ["prUrl"] })
  .refine((r) => r.stage !== "waiting" || r.question, {
    message: "stage waiting needs question",
    path: ["question"],
  });
export type StageReport = z.infer<typeof stageReportSchema>;

const base = {
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  at: z.number().int().nonnegative(),
};

export const eventSchema = z.discriminatedUnion("kind", [
  z.object({
    ...base,
    kind: z.literal("session_start"),
    cwd: z.string(),
    branch: z.string().optional(),
    repo: z.string().optional(),
    source: z.enum(["startup", "resume", "compact"]).optional(),
    t3ThreadId: z.string().optional(),
    title: z.string().optional(),
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_start"),
    toolUseId: z.string().min(1),
    subagentType: z.string(),
    description: z.string(),
    model: z.string().optional(),
    parentAgentId: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_launched"),
    toolUseId: z.string().min(1),
    agentId: z.string().min(1),
  }),
  z.object({
    ...base,
    kind: z.literal("agent_stop"),
    agentId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    usage: usageSchema,
    model: z.string().optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("turn_stop"),
    usage: usageSchema,
    lastMessage: z.string().max(500).optional(),
  }),
  z.object({
    ...base,
    kind: z.literal("stage"),
    ...stageReportShape,
    issueKey: z.string().optional(),
    /** Set by the poller when a human answered a waiting question and the run resumes. */
    answer: z.string().max(4000).optional(),
  }),
  z.object({
    ...base,
    // A mid-turn snapshot of the main session's usage, so spend is known before the turn ends.
    kind: z.literal("usage"),
    usage: usageSchema,
  }),
  z.object({
    ...base,
    kind: z.literal("session_end"),
    reason: z.string().optional(),
  }),
]);
export type FactoryEvent = z.infer<typeof eventSchema>;
export type EventKind = FactoryEvent["kind"];

export const MAX_BATCH = 100;

export const ingestBodySchema = z
  .union([eventSchema, z.array(eventSchema).min(1).max(MAX_BATCH)])
  .transform((body) => (Array.isArray(body) ? body : [body]));
