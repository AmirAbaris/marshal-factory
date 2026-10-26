import type { AgentRow, MachineRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import { STAGES } from "@/lib/events";
import type { BoardCard } from "./cards";
import { StageCard } from "./run-card";
import { STAGE_META } from "./stages";

export function Board({
  cards,
  agentsBySession,
  selected,
  machines,
}: {
  cards: readonly BoardCard[];
  agentsBySession: Map<string, AgentRow[]>;
  selected: string | undefined;
  machines: ReadonlyMap<string, MachineRow>;
}) {
  const agentsOf = (runs: readonly RunRow[]) =>
    runs.flatMap((r) => agentsBySession.get(r.session_id) ?? []);
  const columns = STAGES.filter(
    (stage) => stage !== "failed" || cards.some((c) => c.stage === "failed"),
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 divide-x overflow-auto">
      {columns.map((stage) => {
        const items = cards.filter((c) => c.stage === stage);
        return (
          <section
            key={stage}
            data-stage={stage}
            aria-label={STAGE_META[stage].label}
            // An empty stage keeps only its header, so the stages with work stay in view.
            className={cn("flex min-h-full shrink-0 flex-col last:border-e", items.length > 0 ? "w-84" : "w-36")}
          >
            <div className="sticky top-0 z-10 flex h-9 shrink-0 items-center gap-2 border-b bg-muted/72 px-3 font-medium backdrop-blur-sm">
              <span className={cn("size-2 rounded-full", STAGE_META[stage].dot)} />
              {STAGE_META[stage].label}
              <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
            </div>
            <div className="flex flex-col gap-1.5 p-2">
              {items.length === 0 && <p className="px-1 text-xs text-faint">None</p>}
              {items.map((card) => (
                <StageCard
                  key={card.id}
                  card={card}
                  machineName={card.machineId && (machines.get(card.machineId)?.name ?? card.machineId)}
                  agents={agentsOf(card.runs)}
                  selected={card.runs.some((r) => r.session_id === selected)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
