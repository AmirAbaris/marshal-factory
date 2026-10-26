import { z } from "zod";

/** Where a runner starts new factory threads: in its own T3, or in a Modal sandbox per job. */
export const EXECUTIONS = ["local", "modal"] as const;
export const executionSchema = z.enum(EXECUTIONS);
export type Execution = z.infer<typeof executionSchema>;

export const DEFAULT_EXECUTION: Execution = "local";
