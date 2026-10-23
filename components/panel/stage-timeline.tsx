import type { EventRow } from "@/db/schema";
import { eventSchema, type FactoryEvent, type Stage } from "@/lib/events";
import { cn } from "@/lib/utils";
import { MAIN_PATH, STAGE_META } from "./stages";
import { Time } from "./time";

type StageEvent = Extract<FactoryEvent, { kind: "stage" }>;

type Step = {
  key: string;
  stage: Stage;
  event: StageEvent | undefined;
  state: "done" | "now" | "todo";
};

/** Every report in order, then the main-path stages still ahead of the current one. */
function steps(reports: readonly StageEvent[]): Step[] {
  const reported = reports.map(
    (event, i): Step => ({
      key: event.eventId,
      stage: event.stage,
      event,
      state: i === reports.length - 1 ? "now" : "done",
    }),
  );
  const current = MAIN_PATH.indexOf(reports.at(-1)!.stage);
  const ahead = current === -1 ? [] : MAIN_PATH.slice(current + 1);
  return [
    ...reported,
    ...ahead.map((stage): Step => ({ key: stage, stage, event: undefined, state: "todo" })),
  ];
}

const DOT: Partial<Record<Stage, string>> = {
  waiting: "bg-warning ring-warning/20",
  failed: "bg-destructive ring-destructive/20",
};

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
      {steps(reports).map(({ key, stage, event, state }) => (
        <li
          key={key}
          data-state={state}
          data-stage={stage}
          className="relative pb-3 pl-5 before:absolute before:top-3 before:-bottom-0.5 before:left-[3px] before:w-px before:bg-border last:before:hidden"
        >
          <span
            className={cn(
              "absolute top-1 -left-px size-2.25 rounded-full bg-border",
              state === "done" && "bg-success",
              state === "now" && "bg-primary ring-4 ring-primary/20",
              state === "now" && DOT[stage],
            )}
          />
          <div className="flex justify-between">
            <b className={cn("font-medium", state === "todo" && "text-faint")}>
              {event?.answer ? "Answer received · resumed" : STAGE_META[stage].label}
            </b>
            {event && (
              <span className="font-mono text-xs text-faint">
                <Time date={new Date(event.at)} />
              </span>
            )}
          </div>
          {event?.answer ? (
            <blockquote className="mt-1 border-l-2 border-success/60 pl-2 whitespace-pre-wrap text-muted-foreground">
              {event.answer}
            </blockquote>
          ) : (
            event && (
              <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
                {event.question ?? event.summary}
              </p>
            )
          )}
        </li>
      ))}
    </ol>
  );
}
