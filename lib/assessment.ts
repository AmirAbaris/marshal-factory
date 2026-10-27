import { z } from "zod";

// The agent's merge assessment, sent with stage pr. The agent recommends merge when it is confident
// it built what the issue asked for and that it works, and handover only when it isn't. The
// factory weighs that against its own hard limits (lib/merge-decision.ts); the agent never merges.

const REASON_MAX = 1000;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const confidenceSchema = z.object({
  confident: z.boolean().describe("True when you are confident you built what the issue asked for and that it works."),
  reason: z
    .string()
    .min(1)
    .max(REASON_MAX)
    .optional()
    .describe("Required when not confident: why, in one or two sentences, so the owner knows what to check."),
});

const LEGACY_CHECKS = ["interpretation", "proven", "contained", "reversible", "noTasteCalls", "noSurprises"] as const;
const LEGACY_LABELS: Record<(typeof LEGACY_CHECKS)[number], string> = {
  interpretation: "Confident interpretation",
  proven: "Proven",
  contained: "Contained",
  reversible: "Easy to undo",
  noTasteCalls: "No taste or product calls",
  noSurprises: "No surprises",
};
const legacyCheck = z.object({ ok: z.boolean(), note: z.string().min(1).max(500) });
/** The six checks agents reported before the assessment came down to confidence; still accepted and mapped. */
const legacyChecksSchema = z.object(Object.fromEntries(LEGACY_CHECKS.map((c) => [c, legacyCheck])) as Record<(typeof LEGACY_CHECKS)[number], typeof legacyCheck>);
const legacyFieldsSchema = z.object({ checks: legacyChecksSchema, reviewFocus: z.string().min(1).max(1000).optional() });

/**
 * What report_stage takes. Loose so a report in the older six-check shape (`checks`, `reviewFocus`)
 * keeps those fields and still validates; parseAssessment maps it to the current shape.
 */
export const assessmentInputSchema = z
  .looseObject({
    recommendation: z.enum(["merge", "handover"]).describe("merge when you are confident; handover only when you are not."),
    interpretation: z.string().min(1).max(2000).describe("How you read the issue: what you built and why."),
    assumptions: z.array(z.string().min(1).max(500)).max(12).describe("Every assumption you filled a gap in the issue with."),
    confidence: confidenceSchema.optional().describe("Required: whether you are confident in what you built, and if not, why."),
    notes: z.string().min(1).max(2000).optional().describe("Anything else the owner should know."),
  })
  .refine((a) => a.confidence !== undefined || legacyFieldsSchema.safeParse(a).success, { message: "the assessment needs confidence", path: ["confidence"] })
  .refine((a) => a.confidence?.confident !== false || a.confidence.reason, { message: "say why you aren't confident in confidence.reason", path: ["confidence", "reason"] })
  .refine((a) => !a.confidence || a.confidence.confident === (a.recommendation === "merge"), {
    message: "recommend merge when confident and handover when not",
    path: ["recommendation"],
  });
export type AssessmentInput = z.infer<typeof assessmentInputSchema>;

export type MergeAssessment = {
  recommendation: "merge" | "handover";
  interpretation: string;
  assumptions: string[];
  confidence: { confident: boolean; reason?: string };
  notes?: string;
};

/** A six-check report: merge meant confident; a handover's failed checks, or else its review focus, are the reason. */
function fromLegacy(a: AssessmentInput, { checks, reviewFocus }: z.infer<typeof legacyFieldsSchema>): Pick<MergeAssessment, "confidence" | "notes"> {
  const notes = reviewFocus && { notes: reviewFocus };
  if (a.recommendation === "merge") return { confidence: { confident: true }, ...notes };
  const failed = LEGACY_CHECKS.filter((c) => !checks[c].ok).map((c) => `${LEGACY_LABELS[c]}: ${checks[c].note}`);
  if (failed.length > 0) return { confidence: { confident: false, reason: clip(failed.join(" "), REASON_MAX) }, ...notes };
  return { confidence: { confident: false, reason: reviewFocus ?? "It recommended handing over." } };
}

/** A validated report in either shape, in the current one. */
export function normalizeAssessment(a: AssessmentInput): MergeAssessment {
  const base = { recommendation: a.recommendation, interpretation: a.interpretation, assumptions: a.assumptions };
  if (a.confidence) return { ...base, confidence: a.confidence, ...(a.notes && { notes: a.notes }) };
  return { ...base, ...fromLegacy(a, legacyFieldsSchema.parse(a)) };
}

/** A stored assessment, from before or after the six checks were dropped, or null when it isn't one. */
export function parseAssessment(value: unknown): MergeAssessment | null {
  const parsed = assessmentInputSchema.safeParse(value);
  return parsed.success ? normalizeAssessment(parsed.data) : null;
}
