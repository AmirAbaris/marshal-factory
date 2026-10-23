import type { EventRow } from "@/db/schema";
import { eventSchema, type FactoryEvent, type Stage } from "@/lib/events";
import { cn } from "@/lib/utils";
import { MAIN_PATH, STAGE_META } from "./stages";
import { Time } from "./time";

type StageEvent = Extract<FactoryEvent, { kind: "stage" }>;

type Step = { stage: Stage; event: StageEvent | undefined; state: "done" | "now" | "todo" };

/** The main path with the latest report per stage, plus waiting or failed when the run went there. */
function steps(reports: readonly StageEvent[]): Step[] {
  const last = new Map<Stage, StageEvent>();
  for (const report of reports) last.set(report.stage, report);
  const current = reports.at(-1)?.stage;
  const reached = new Set(reports.map((r) => r.stage));
  const offPath = (["waiting", "failed"] as const).filter((s) => reached.has(s));
  const order = [...MAIN_PATH.filter((s) => s !== "queued" || reached.has(s)), ...offPath];
  // Stages the run skipped on its way to a later one still count as passed.
  const furthest = Math.max(...[...reached].map((s) => MAIN_PATH.indexOf(s)));
  return order.map((stage) => ({
    stage,
    event: last.get(stage),
    state:
      stage === current
        ? "now"
        : reached.has(stage) || MAIN_PATH.indexOf(stage) < furthest
          ? "done"
          : "todo",
  }));
}

export function StageTimeline({ events }: { events: readonly EventRow[] }) {
  const reports = events.flatMap((row) => {
    const parsed = eventSchema.safeParse(row.payload);
    return parsed.success && parsed.data.kind === "stage" ? [parsed.data] : [];
  });
  if (reports.length === 0) {
    return <p className="text-muted-foreground">No stage reported yet.</p>;
  }
  return (
    <ol className="ml-1.5 flex flex-col">
      {steps(reports).map(({ stage, event, state }) => (
        <li
          key={stage}
          data-state={state}
          className="relative pb-3 pl-5 before:absolute before:top-3 before:-bottom-0.5 before:left-[3px] before:w-px before:bg-border last:before:hidden"
        >
          <span
            className={cn(
              "absolute top-1 -left-px size-2.25 rounded-full bg-border",
              state === "done" && "bg-success",
              state === "now" && "bg-primary ring-4 ring-primary/20",
              state === "now" && stage === "failed" && "bg-destructive ring-destructive/20",
              state === "now" && stage === "waiting" && "bg-warning ring-warning/20",
            )}
          />
          <div className="flex justify-between">
            <b className={cn("font-medium", state === "todo" && "text-faint")}>
              {STAGE_META[stage].label}
            </b>
            {event && (
              <span className="font-mono text-xs text-faint">
                <Time date={new Date(event.at)} />
              </span>
            )}
          </div>
          {event && (
            <p className="mt-0.5 text-muted-foreground">{event.question ?? event.summary}</p>
          )}
        </li>
      ))}
    </ol>
  );
}
