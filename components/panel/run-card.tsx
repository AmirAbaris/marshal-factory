import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, RunRow } from "@/db/schema";
import { cn } from "@/lib/utils";
import type { BoardCard } from "./cards";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { ModelChip } from "./model-chip";

const cardClass = (selected: boolean) =>
  cn(
    "relative flex flex-col gap-2 rounded-lg border bg-secondary p-2.5 text-left transition-colors hover:border-input",
    selected && "border-primary ring-1 ring-primary",
  );

function AgentsAndCost({ runs, agents }: { runs: readonly RunRow[]; agents: readonly AgentRow[] }) {
  const running = agents.filter((a) => a.status === "running").length;
  const cost = runs.reduce(
    (sum, run) => sum + runCost(run, agents.filter((a) => a.session_id === run.session_id)),
    0,
  );
  return (
    <>
      {agents.length > 0 && (
        <span>
          {running > 0 ? `${running}/${agents.length}` : agents.length} agents
        </span>
      )}
      <span className="font-mono">{formatUsd(cost)}</span>
    </>
  );
}

const prLabel = (url: string) => {
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `PR #${number}` : "PR";
};

export function StageCard({
  card,
  agents,
  selected,
}: {
  card: BoardCard;
  agents: readonly AgentRow[];
  selected: boolean;
}) {
  const { latest } = card;
  return (
    <div data-card={card.id} className={cardClass(selected)}>
      {latest && (
        <Link
          href={`/?run=${latest.session_id}`}
          scroll={false}
          aria-label={`Open ${card.issueKey ?? card.title}`}
          className="absolute inset-0 rounded-lg"
        />
      )}
      <div className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {latest?.status === "active" && <Spinner className="size-2.5" />}
        {card.issueKey ?? card.id.slice(0, 8)}
      </div>
      <div className="line-clamp-2 font-medium">{card.title}</div>
      {card.stage === "waiting" && card.question ? (
        <p className="line-clamp-3 text-xs text-warning">{card.question}</p>
      ) : (
        card.summary && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{card.summary}</p>
        )
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        {latest && <ModelChip model={latest.model} />}
        <AgentsAndCost runs={card.runs} agents={agents} />
        {card.issueUrl && (
          <a
            href={card.issueUrl}
            target="_blank"
            rel="noreferrer"
            className="relative underline-offset-2 hover:underline"
          >
            Linear
          </a>
        )}
        {card.prUrl && (
          <a
            href={card.prUrl}
            target="_blank"
            rel="noreferrer"
            className="relative font-mono text-foreground underline-offset-2 hover:underline"
          >
            {prLabel(card.prUrl)}
          </a>
        )}
      </div>
    </div>
  );
}

export function RunCard({
  run,
  agents,
  selected,
}: {
  run: RunRow;
  agents: readonly AgentRow[];
  selected: boolean;
}) {
  return (
    <Link
      href={`/?run=${run.session_id}`}
      scroll={false}
      className={cn(cardClass(selected), run.status === "ended" && "opacity-60")}
    >
      <div className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {run.status === "active" && <Spinner className="size-2.5" />}
        {run.issue_key ?? shortId(run.session_id)}
      </div>
      <div className="line-clamp-2 font-medium">{runTitle(run)}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="rounded-md font-normal">
          {run.status}
        </Badge>
        <ModelChip model={run.model} />
        <AgentsAndCost runs={[run]} agents={agents} />
      </div>
      {run.repo && (
        <div className="truncate font-mono text-xs text-faint">
          {run.repo}
          {run.branch ? ` · ${run.branch}` : ""}
        </div>
      )}
    </Link>
  );
}
