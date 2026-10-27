import { CheckIcon, XIcon } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { JobRow } from "@/db/schema";
import { parseAssessment, type MergeAssessment } from "@/lib/assessment";
import { AUTONOMY_LABELS, mergeDecisionSchema, type FactoryMerge, type MergeDecision, type MergeWatch } from "@/lib/merge-decision";
import { cn } from "@/lib/utils";
import { shownDecision } from "./cards";
import { Time } from "./time";

export const parseDecision = (value: unknown): MergeDecision | null => mergeDecisionSchema.safeParse(value).data ?? null;

const READY = "Ready for your review";

export type DecisionLine = { text: string; tone: string; link?: { href: string; label: string } };

function mergedLine(watch: MergeWatch | undefined): DecisionLine {
  const merged = { text: "Merged by the factory", tone: "text-success" };
  if (!watch) return merged;
  const revert = watch.revertPr ? { href: watch.revertPr, label: "Revert PR" } : undefined;
  switch (watch.state) {
    case "watching":
      return { text: "Watching main after merge", tone: "text-muted-foreground" };
    case "green":
    case "expired":
      return merged;
    case "reverted":
      return { text: "Reverted after main went red", tone: "text-destructive", link: revert };
    case "revert_failed":
      return { text: `Revert failed after main went red · ${watch.reason}`, tone: "text-destructive", link: revert };
    default: {
      const never: never = watch.state;
      throw new Error(`unknown watch state ${String(never)}`);
    }
  }
}

/** The one line a card in pr, or merged by the factory, shows under its title. */
export function decisionLine(decision: MergeDecision | null): DecisionLine {
  if (decision?.merged) return mergedLine(decision.watch);
  if (!decision || decision.autonomy === "off") return { text: READY, tone: "text-foreground" };
  switch (decision.outcome) {
    case "merge":
      return decision.autonomy === "auto" ? { text: "Merging", tone: "text-success" } : { text: "Would merge (trial)", tone: "text-success" };
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

/** Whether the agent is confident in what it built, and why not when it isn't. */
export function Confidence({ assessment: { confidence } }: { assessment: MergeAssessment }) {
  return (
    <div className="flex gap-2">
      {confidence.confident ? <CheckIcon className="mt-0.5 size-4 shrink-0 text-success" /> : <XIcon className="mt-0.5 size-4 shrink-0 text-destructive" />}
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{confidence.confident ? "Confident" : "Not confident"}</span>
        <span className="whitespace-pre-wrap text-muted-foreground">
          {confidence.confident ? "It built what the issue asked for and showed that it works." : (confidence.reason ?? "No reason given.")}
        </span>
      </div>
    </div>
  );
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
      <Confidence assessment={assessment} />
      {assessment.notes && (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium text-muted-foreground">Notes</h4>
          <p className="whitespace-pre-wrap">{assessment.notes}</p>
        </div>
      )}
    </div>
  );
}

function Watch({ merged, watch }: { merged: FactoryMerge; watch: MergeWatch | undefined }) {
  return (
    <div className="flex flex-col gap-1 text-muted-foreground">
      <p>
        Merged as <span className="font-mono">{merged.sha.slice(0, 7)}</span> ({merged.method}) <Time date={new Date(merged.at)} />
      </p>
      {watch?.state === "watching" && (
        <p>
          Watching the checks on {merged.base} until <Time date={new Date(watch.until)} />
        </p>
      )}
      {watch?.state === "green" && <p>The checks on {merged.base} stayed green.</p>}
      {watch?.state === "expired" && <p>The checks on {merged.base} didn&apos;t finish in time, so the watch ended.</p>}
      {watch && watch.failed.length > 0 && <p>Failed on {merged.base}: {watch.failed.join(", ")}</p>}
    </div>
  );
}

/** The runner's decision for a job in pr, or its watch on main once the factory merged it, and the agent's assessment behind it. */
export function MergeDecisionSection({ job }: { job: JobRow }) {
  const decision = shownDecision(job);
  const assessment = parseAssessment(job.merge_assessment);
  if (!decision && job.stage !== "pr" && !assessment) return null;
  const line = decisionLine(decision);
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5 text-sm">
        <h3 className="text-sm font-medium text-muted-foreground">Merge decision</h3>
        {(job.stage === "pr" || decision) && (
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("font-medium", line.tone)}>{decision?.outcome === "handover" && !decision.merged ? READY : line.text}</span>
              {line.link && (
                <a href={line.link.href} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-2">
                  {line.link.label}
                </a>
              )}
              {decision && (
                <span className="ml-auto text-xs text-faint">
                  {AUTONOMY_LABELS[decision.autonomy]} · <Time date={new Date(decision.evaluatedAt)} />
                </span>
              )}
            </div>
            {decision?.merged && <Watch merged={decision.merged} watch={decision.watch} />}
            {decision && !decision.merged && decision.reasons.length > 0 && (
              <ul className="list-disc pl-4 text-muted-foreground">
                {decision.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {assessment ? <Assessment assessment={assessment} /> : <p className="text-muted-foreground">The agent didn&apos;t report an assessment.</p>}
      </section>
    </>
  );
}
