import { z } from "zod";

// The agent's merge assessment, sent with stage pr. The factory weighs it against its own hard
// limits (lib/merge-decision.ts); the agent never merges.

export const ASSESSMENT_CHECKS = ["interpretation", "proven", "contained", "reversible", "noTasteCalls", "noSurprises"] as const;
export type AssessmentCheck = (typeof ASSESSMENT_CHECKS)[number];

export const CHECK_LABELS: Record<AssessmentCheck, string> = {
  interpretation: "Confident interpretation",
  proven: "Proven",
  contained: "Contained",
  reversible: "Easy to undo",
  noTasteCalls: "No taste or product calls",
  noSurprises: "No surprises",
};

const checkSchema = z.object({ ok: z.boolean(), note: z.string().min(1).max(500) });

export const assessmentSchema = z
  .object({
    recommendation: z.enum(["merge", "handover"]).describe("merge only when all six checks hold; otherwise handover."),
    interpretation: z.string().min(1).max(2000).describe("How you read the issue: what you built and why."),
    assumptions: z.array(z.string().min(1).max(500)).max(12).describe("Every assumption you filled a gap in the issue with."),
    checks: z.object({
      interpretation: checkSchema.describe("One reasonable reading, filled by codebase patterns, cheap to change, no business call."),
      proven: checkSchema.describe("Reproduced before, fixed after on the real surface; a test that fails without the change; checks green."),
      contained: checkSchema.describe("Touches only what the issue is about; no shared contract or public API changed."),
      reversible: checkSchema.describe("A plain revert undoes it; no data migration, no external side effects."),
      noTasteCalls: checkSchema.describe("No taste, product, pricing, legal or prominent copy decisions."),
      noSurprises: checkSchema.describe("No flaky tests, unrelated breakage or spec contradicting code."),
    }),
    reviewFocus: z.string().min(1).max(1000).optional().describe("What the owner should look at first."),
  })
  .refine((a) => a.recommendation === "handover" || ASSESSMENT_CHECKS.every((c) => a.checks[c].ok), {
    message: "recommend merge only when all six checks are ok",
    path: ["recommendation"],
  });
export type MergeAssessment = z.infer<typeof assessmentSchema>;
