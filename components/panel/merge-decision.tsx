import { CheckIcon, XIcon } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { JobRow } from "@/db/schema";
import { ASSESSMENT_CHECKS, assessmentSchema, CHECK_LABELS, type MergeAssessment } from "@/lib/assessment";
import { AUTONOMY_LABELS, mergeDecisionSchema, type MergeDecision } from "@/lib/merge-decision";
import { cn } from "@/lib/utils";
import { Time } from "./time";

export const parseDecision = (value: unknown): MergeDecision | null => mergeDecisionSchema.safeParse(value).data ?? null;
const parseAssessment = (value: unknown): MergeAssessment | null => assessmentSchema.safeParse(value).data ?? null;

const READY = "Ready for your review";

/** The one line a card in pr shows under its title. */
export function decisionLine(decision: MergeDecision | null): { text: string; tone: string } {
  if (!decision || decision.autonomy === "off") return { text: READY, tone: "text-foreground" };
  switch (decision.outcome) {
    case "merge":
      return { text: "Would merge (trial)", tone: "text-success" };
    case "pending":
      return { text: "Waiting for checks", tone: "text-muted-foreground" };
    case "handover":
      return { text: decision.reasons[0] ? `${READY} · ${decision.reasons[0]}` : READY, tone: "text-foreground" };
    default: {
      const never: never = decision.outcome;
      throw new Error(`unknown merge outcome ${String(never)}`);
    }
  }
}

function Assessment({ assessment }: { assessment: MergeAssessment }) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-muted-foreground">
        The agent recommends {assessment.recommendation === "merge" ? "merging" : "handing over"}.
      </p>
      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium text-muted-foreground">Interpretation</h4>
        <p className="whitespace-pre-wrap">{assessment.interpretation}</p>
      </div>
      {assessment.assumptions.length > 0 && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Assumptions</h4>
          <ul className="list-disc pl-4">
            {assessment.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {ASSESSMENT_CHECKS.map((name) => {
          const check = assessment.checks[name];
          return (
            <li key={name} className="flex gap-2">
              {check.ok ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" /> : <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />}
              <div className="flex min-w-0 flex-col">
                <span className="font-medium">{CHECK_LABELS[name]}</span>
                <span className="text-muted-foreground">{check.note}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {assessment.reviewFocus && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">What to look at</h4>
          <p className="whitespace-pre-wrap">{assessment.reviewFocus}</p>
        </div>
      )}
    </div>
  );
}

/** The runner's decision for a job in pr and the agent's assessment behind it. */
export function MergeDecisionSection({ job }: { job: JobRow }) {
  const decision = job.stage === "pr" ? parseDecision(job.merge_decision) : null;
  const assessment = parseAssessment(job.merge_assessment);
  if (job.stage !== "pr" && !assessment) return null;
  const line = decisionLine(decision);
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5 text-sm">
        <h3 className="text-sm font-medium text-muted-foreground">Merge decision</h3>
        {job.stage === "pr" && (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", line.tone)}>{decision?.outcome === "handover" ? READY : line.text}</span>
              {decision && (
                <span className="ml-auto text-xs text-faint">
                  {AUTONOMY_LABELS[decision.autonomy]} · <Time date={new Date(decision.evaluatedAt)} />
                </span>
              )}
            </div>
            {decision && decision.reasons.length > 0 && (
              <ul className="list-disc pl-4 text-muted-foreground">
                {decision.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {assessment ? <Assessment assessment={assessment} /> : <p className="text-muted-foreground">The agent didn&apos;t report a merge assessment.</p>}
      </section>
    </>
  );
}
