"use client";

import { useLiveQuery } from "@neon/realtime-react";
import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentRow, EventRow, JobRow, RunRow } from "@/db/schema";
import { sourceLink } from "@/lib/sources/shapes";
import { AgentTree } from "./agent-tree";
import { EventFeed } from "./event-feed";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { ModelChip } from "./model-chip";
import { fetchSealed, type Feed } from "./sealed";
import { StageTimeline } from "./stage-timeline";
import { Time } from "./time";
import { STAGE_META } from "./stages";

export function RunDetail({
  run,
  agents,
  events,
  stages,
  stagesPath,
  job,
  jobSpend,
}: {
  jobSpend: { usd: number; capUsd: number; attempt: number } | undefined;
  stagesPath: string;
  job: JobRow | undefined;
  run: RunRow;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
}) {
  const base = `/api/live/runs/${encodeURIComponent(run.session_id)}`;
  // Server re-renders hand over a fresh sealed object for the same query; keep the first.
  const [agentsQuery] = useState(agents.sealedQuery);
  const [eventsQuery] = useState(events.sealedQuery);
  const [stagesQuery] = useState(stages.sealedQuery);
  const refreshAgents = useCallback(() => fetchSealed<AgentRow>(`${base}/agents`), [base]);
  const refreshEvents = useCallback(() => fetchSealed<EventRow>(`${base}/events`), [base]);
  const refreshStages = useCallback(() => fetchSealed<EventRow>(stagesPath), [stagesPath]);

  const liveAgents = useLiveQuery(agentsQuery, {
    refreshQuery: refreshAgents,
    initialData: agents.initialData,
  });
  const liveEvents = useLiveQuery(eventsQuery, {
    refreshQuery: refreshEvents,
    initialData: events.initialData,
  });
  const liveStages = useLiveQuery(stagesQuery, {
    refreshQuery: refreshStages,
    initialData: stages.initialData,
  });
  const agentRows = liveAgents.data ?? agents.initialData;
  const stage = job?.stage ?? run.stage;
  const link = job && sourceLink(job);
  const stageRows = liveStages.data ?? stages.initialData;
  const eventRows = liveEvents.data ?? events.initialData;

  return (
    <aside className="flex min-h-0 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-4.5 py-4">
          <div className="flex items-center justify-between font-mono text-xs text-faint">
            <span>
              {run.job_key ?? shortId(run.session_id)}
              {run.branch ? ` · ${run.branch}` : ""}
            </span>
            <Button asChild variant="ghost" size="icon-sm" aria-label="Close run">
              <Link href="/" scroll={false}>
                <XIcon />
              </Link>
            </Button>
          </div>
          <h2 className="text-base font-semibold">{job?.title ?? runTitle(run)}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {stage && (
              <Badge variant="outline" className="gap-1.5 rounded-md font-normal">
                <span className={`size-1.5 rounded-full ${STAGE_META[stage].dot}`} />
                {STAGE_META[stage].label}
              </Badge>
            )}
            <Badge variant="outline" className="rounded-md font-normal">
              {run.status}
            </Badge>
            <ModelChip model={run.model} />
            {run.repo && <span className="text-muted-foreground">{run.repo}</span>}
            <span className="font-mono text-muted-foreground">
              {jobSpend ? (
                <span className={cn(jobSpend.usd >= jobSpend.capUsd && "text-destructive")}>
                  {jobSpend.attempt > 1 && `attempt ${jobSpend.attempt}: `}
                  {formatUsd(jobSpend.usd)} of {formatUsd(jobSpend.capUsd)} cap
                </span>
              ) : (
                formatUsd(runCost(run, agentRows))
              )}
            </span>
            {link && (
              <Button asChild variant="outline" size="sm" className="ml-auto">
                <a href={link.href} target="_blank" rel="noreferrer">
                  {link.label}
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            )}
            {run.pr_url && (
              <Button asChild variant="outline" size="sm" className={job ? "" : "ml-auto"}>
                <a href={run.pr_url} target="_blank" rel="noreferrer">
                  Pull request
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            )}
            {run.t3_thread_id && (
              <Button asChild variant="outline" size="sm" className={job || run.pr_url ? "" : "ml-auto"}>
                <a href={`t3-thread://v1/${run.t3_thread_id}`}>
                  Open in T3
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            )}
          </div>
        </div>
        {job?.nudged_at && job.nudged_stage === job.stage && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
            <span className="font-semibold tracking-wider text-warning uppercase">Stuck</span> · the
            watchdog nudged this run at <Time date={job.nudged_at} /> in{" "}
            {STAGE_META[job.stage].label}. It fails if nothing moves.
          </div>
        )}
        {job?.answered_at && job.answer && job.stage !== "waiting" && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5">
            <div className="text-xs font-semibold tracking-wider text-success uppercase">
              Answer received <Time date={job.answered_at} />
            </div>
            <p className="mt-1 whitespace-pre-wrap">{job.answer}</p>
          </div>
        )}
        {job?.stage === "waiting" && job.question ? (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div className="text-xs font-semibold tracking-wider text-warning uppercase">
              Question for you
            </div>
            <p className="mt-1 whitespace-pre-wrap">{job.question}</p>
          </div>
        ) : null}
        {!job && run.stage === "waiting" && run.question && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div className="text-xs font-semibold tracking-wider text-warning uppercase">
              Question for you
            </div>
            <p className="mt-1 whitespace-pre-wrap">{run.question}</p>
          </div>
        )}
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">
            Timeline
          </h3>
          <StageTimeline events={stageRows} />
        </section>
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">
            Agents · {agentRows.length}
          </h3>
          <AgentTree run={run} agents={agentRows} />
        </section>
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-xs font-semibold tracking-wider text-faint uppercase">
            Live events
          </h3>
          <EventFeed events={eventRows} />
        </section>
      </ScrollArea>
    </aside>
  );
}
