import { createHash } from "node:crypto";
import type { MergeAssessment } from "./assessment";
import { PRODUCER_LABELS, shortSha } from "./evidence";
import type { MergeDecision } from "./merge-decision";

// The comments a merge decision leaves on its PR and in its source. Each body follows from the
// decision alone, so the runner posts one only when its fingerprint changes.

export const DECISION_MARKER = "<!-- marshal-factory:decision -->";

export const fingerprint = (body: string) => createHash("sha256").update(body).digest("hex").slice(0, 16);

const bullets = (items: readonly string[]) => items.map((i) => `- ${i}`).join("\n");
const failedList = (failed: readonly string[]) => (failed.length > 0 ? failed.join(", ") : "a check failed");

const confidenceLine = ({ confidence }: MergeAssessment) =>
  confidence.confident ? "Confident it built what the issue asked for and that it works." : `Not confident: ${confidence.reason ?? "no reason given."}`;

function assessmentBlock(assessment: MergeAssessment | null) {
  if (!assessment) return [];
  return [
    `**How I read the issue**\n\n${assessment.interpretation}`,
    assessment.assumptions.length > 0 ? `**Assumptions I made**\n\n${bullets(assessment.assumptions)}` : "",
    `**Confidence**\n\n${confidenceLine(assessment)}`,
    assessment.notes ? `**Notes**\n\n${assessment.notes}` : "",
  ];
}

function watchLine({ watch }: MergeDecision) {
  if (!watch) return "";
  switch (watch.state) {
    case "reverted":
      return `Reverted in ${watch.revertPr} after main went red: ${failedList(watch.failed)}.`;
    case "revert_failed":
      return `Main went red after the merge (${failedList(watch.failed)}) and the revert failed: ${watch.reason}`;
    case "watching":
    case "green":
    case "expired":
      return "";
    default: {
      const never: never = watch.state;
      throw new Error(`unknown watch state ${String(never)}`);
    }
  }
}

/** What the merge rests on beyond GitHub's checks: the checks run at exactly the merged head. */
function evidenceLine({ evidence }: MergeDecision) {
  if (evidence?.state !== "verified") return "";
  return `Verified at ${shortSha(evidence.sha)} · ${evidence.passed}/${evidence.total} checks, run by ${PRODUCER_LABELS[evidence.producer]}.`;
}

/** The PR comment for the decision, or null when it has nothing to say there yet. */
export function prCommentBody(decision: MergeDecision, assessment: MergeAssessment | null): string | null {
  const parts = (() => {
    if (decision.merged) return ["✅ Merged by the factory", evidenceLine(decision), watchLine(decision), ...assessmentBlock(assessment)];
    if (decision.autonomy === "off") return null;
    switch (decision.outcome) {
      case "pending":
        return null;
      case "merge":
        return decision.autonomy === "trial" ? ["Would merge (trial)", evidenceLine(decision), ...assessmentBlock(assessment)] : null;
      case "handover":
        if (decision.autonomy === "trial") return [`Would hand over (trial) because:\n\n${bullets(decision.reasons)}`];
        return [
          "Ready for your review",
          bullets(decision.reasons),
          assessment?.notes ? `**Notes**\n\n${assessment.notes}` : "",
        ];
      default: {
        const never: never = decision.outcome;
        throw new Error(`unknown merge outcome ${String(never)}`);
      }
    }
  })();
  return parts && [DECISION_MARKER, ...parts].filter(Boolean).join("\n\n");
}

/** The source comment for the decision: merges, handovers and reverts, never a pending tick. */
export function sourceCommentBody(decision: MergeDecision, prUrl: string): string | null {
  if (decision.merged) {
    const watch = decision.watch;
    if (watch?.state === "reverted") return `Reverted: main went red after merge — ${failedList(watch.failed)}. Revert: ${watch.revertPr}`;
    if (watch?.state === "revert_failed") {
      return `Main went red after the factory merged ${prUrl} — ${failedList(watch.failed)}. The revert failed, so revert it by hand: ${watch.reason}`;
    }
    return `Merged by the factory: ${prUrl}`;
  }
  if (decision.autonomy === "off") return null;
  switch (decision.outcome) {
    case "pending":
      return null;
    case "merge":
      return decision.autonomy === "trial" ? `Would merge (trial): ${prUrl}` : null;
    case "handover":
      return `${decision.autonomy === "trial" ? "Would hand over (trial)" : "Ready for your review"}: ${prUrl}\n\n${bullets(decision.reasons)}`;
    default: {
      const never: never = decision.outcome;
      throw new Error(`unknown merge outcome ${String(never)}`);
    }
  }
}
