"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import type { AgentRow, AuditRow, EventRow, JobEvidenceRow, JobRow, MachineRow, RunRow } from "@/db/schema";
import { sandboxState } from "@/lib/execution";
import { harnessLabel, type Harness } from "@/lib/harness";
import { parseInventory, t3ThreadLink, UNKNOWN } from "@/lib/machine";
import { sourceLink } from "@/lib/sources/shapes";
import { parseStop, stopLine, stopView } from "@/lib/stop";
import { runFeedPath } from "@/lib/run-links";
import { RUNS_ON_LABELS, ticketRecordSchema } from "@/lib/ticket-overrides";
import { runsOn } from "./cards";
import { AgentTree } from "./agent-tree";
import { EventFeed } from "./event-feed";
import { EvidenceSection } from "./evidence";
import { AuditLog } from "./audit-log";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { MergeButton } from "./merge-button";
import { MergeDecisionSection } from "./merge-decision";
import { ModelChip } from "./model-chip";
import { OpenSandboxT3 } from "./open-sandbox-t3";
import { SandboxSection } from "./sandbox-section";
import { useFeed, type Feed } from "./sealed";
import { StageTimeline } from "./stage-timeline";
import { Time } from "./time";
import { STAGE_META } from "./stages";

/** The job's audit feed, read once for both the sandbox's last login check and the audit log. */
function JobRecords({ feed, path, job }: { feed: Feed<AuditRow>; path: string; job: JobRow | undefined }) {
  const { rows } = useFeed(feed, path);
  return (
    <>
      {job && <SandboxSection job={job} audit={rows} />}
      <AuditLog rows={rows} />
    </>
  );
}

/** What the ticket's override labels chose for this attempt, and what the runner did instead where it could not. */
function TicketOverrides({ job, harnesses }: { job: JobRow; harnesses: readonly Harness[] }) {
  const ticket = ticketRecordSchema.safeParse(job.ticket_overrides).data;
  if (!ticket) return null;
  const provider = ticket.provider;
  const chosen = [
    provider && `Harness ${harnesses.find((h) => h.id === provider)?.name ?? harnessLabel(provider)}`,
    ticket.execution && `Runs on ${RUNS_ON_LABELS[ticket.execution]}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 text-xs">
      {chosen.length > 0 && <p className="text-muted-foreground">From the ticket: {chosen.join(" · ")}</p>}
      {ticket.notes.map((note) => (
        <p key={note} className="text-warning">
          {note}
        </p>
      ))}
    </div>
  );
}

const STOP_BOX = {
  stopping: { box: "border-warning/40 bg-warning/10", title: "text-warning" },
  confirmed: { box: "border-border bg-muted/40", title: "text-foreground" },
  unconfirmed: { box: "border-destructive/40 bg-destructive/10", title: "text-destructive" },
} as const;

/** Where the job's stop is: what the runner last did, why it counts as stopped, or why it could not tell. */
function StopBanner({ job, t3Href }: { job: JobRow; t3Href: string | null }) {
  const sandboxed = runsOn(job)?.kind === "modal";
  const view = stopView(job.stop, sandboxed);
  const stop = parseStop(job.stop);
  if (!view || !stop) return null;
  const detail = view.kind === "stopping" ? stop.step : view.kind === "confirmed" ? view.evidence : view.reason;
  return (
    <div className={cn("mx-4.5 mb-3.5 flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-xs", STOP_BOX[view.kind].box)}>
      <div className={cn("font-semibold", STOP_BOX[view.kind].title)}>{stopLine(view)}</div>
      {detail && <p className="text-muted-foreground">{detail}</p>}
      <p className="text-muted-foreground">
        Stop asked by {stop.by} <Time date={new Date(stop.requestedAt)} />
        {stop.retries > 0 && ` · retried ${stop.retries}×`}
        {view.kind === "stopping" && " · the job keeps its slot until the stop is confirmed"}
      </p>
      {view.kind === "unconfirmed" && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {sandboxed ? (
            <OpenSandboxT3 jobId={job.id} />
          ) : (
            t3Href && (
              <Button render={<a href={t3Href} />} variant="outline" size="sm">
                Open in T3
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )
          )}
          <span className="text-muted-foreground">Retry stop or dismiss it in the inbox once the thread has stopped.</span>
        </div>
      )}
    </div>
  );
}

export function RunDetail({
  run,
  agents,
  events,
  stages,
  stagesPath,
  audit,
  evidence,
  job,
  machine,
  harnesses,
  jobSpend,
  closeHref,
}: {
  harnesses: readonly Harness[];
  /** Where the close button goes: the page the run opened on. */
  closeHref: string;
  audit: { feed: Feed<AuditRow>; path: string } | undefined;
  evidence: { feed: Feed<JobEvidenceRow>; path: string } | undefined;
  jobSpend: { usd: number; capUsd: number; attempt: number } | undefined;
  stagesPath: string;
  job: JobRow | undefined;
  machine: MachineRow | undefined;
  run: RunRow;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
}) {
  const { rows: agentRows } = useFeed(agents, runFeedPath("agents", run.session_id));
  const { rows: eventRows } = useFeed(events, runFeedPath("events", run.session_id));
  const { rows: stageRows } = useFeed(stages, stagesPath);
  const stage = job?.stage ?? run.stage;
  const link = job && sourceLink(job);
  const machineName = machine?.name ?? job?.machine_id ?? null;
  const t3 = machine && parseInventory(machine.inventory)?.t3;
  const environmentId = t3 && t3 !== UNKNOWN ? t3.environmentId : null;
  const sandboxed = job ? sandboxState(job) !== null : false;
  const where = job && runsOn(job);
  const stopThread = job && (parseStop(job.stop)?.thread ?? job.t3_thread_id);

  return (
    <aside className="flex min-h-0 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-4.5 py-4">
          <div className="flex items-center justify-between font-mono text-xs text-faint">
            <span>
              {run.job_key ?? shortId(run.session_id)}
              {run.branch ? ` · ${run.branch}` : ""}
            </span>
            <Button render={<Link href={closeHref} scroll={false} />} variant="ghost" size="icon-sm" aria-label="Close run">
              <XIcon />
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
            {machineName && (
              <span className="text-muted-foreground">{where?.kind === "modal" ? `Modal sandbox · Managed by ${machineName}` : `Local · ${machineName}`}</span>
            )}
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
              <Button render={<a href={link.href} target="_blank" rel="noreferrer" />} variant="outline" size="sm" className="ml-auto">
                {link.label}
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )}
            {run.pr_url && (
              <Button render={<a href={run.pr_url} target="_blank" rel="noreferrer" />} variant="outline" size="sm" className={job ? "" : "ml-auto"}>
                Pull request
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )}
            {job?.stage === "pr" && job.pr_url && <MergeButton key={job.pr_url} jobId={job.id} jobKey={job.key} />}
            {job && sandboxed ? (
              <OpenSandboxT3 jobId={job.id} />
            ) : run.t3_thread_id && (
              <Button
                render={<a href={t3ThreadLink(run.t3_thread_id, environmentId)} />}
                variant="outline"
                size="sm"
                className={job || run.pr_url ? "" : "ml-auto"}
              >
                Open in T3{machineName && ` on ${machineName}`}
                <ExternalLinkIcon data-icon="inline-end" />
              </Button>
            )}
          </div>
          {job && <TicketOverrides job={job} harnesses={harnesses} />}
        </div>
        {job && <StopBanner job={job} t3Href={stopThread ? t3ThreadLink(stopThread, environmentId) : null} />}
        {job?.nudged_at && job.nudged_stage === job.stage && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5 text-xs">
            <span className="font-semibold text-warning">Stuck</span> · the
            watchdog nudged this run at <Time date={job.nudged_at} /> in{" "}
            {STAGE_META[job.stage].label}. It fails if nothing moves.
          </div>
        )}
        {job?.answered_at && job.answer && job.stage !== "waiting" && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5">
            <div className="text-xs font-semibold text-success">
              Answer received <Time date={job.answered_at} />
            </div>
            <p className="mt-1 whitespace-pre-wrap">{job.answer}</p>
          </div>
        )}
        {job?.stage === "waiting" && job.question ? (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div className="text-xs font-semibold text-warning">
              Question for you
            </div>
            <p className="mt-1 whitespace-pre-wrap">{job.question}</p>
          </div>
        ) : null}
        {!job && run.stage === "waiting" && run.question && (
          <div className="mx-4.5 mb-3.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2.5">
            <div className="text-xs font-semibold text-warning">
              Question for you
            </div>
            <p className="mt-1 whitespace-pre-wrap">{run.question}</p>
          </div>
        )}
        {job && <MergeDecisionSection job={job} />}
        {job && evidence && <EvidenceSection feed={evidence.feed} path={evidence.path} job={job} />}
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-sm font-medium text-muted-foreground">
            Timeline
          </h3>
          <StageTimeline events={stageRows} />
        </section>
        {audit ? <JobRecords feed={audit.feed} path={audit.path} job={job} /> : job && <SandboxSection job={job} audit={[]} />}
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-sm font-medium text-muted-foreground">
            Agents · {agentRows.length}
          </h3>
          <AgentTree run={run} agents={agentRows} />
        </section>
        <Separator />
        <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
          <h3 className="text-sm font-medium text-muted-foreground">
            Live events
          </h3>
          <EventFeed events={eventRows} />
        </section>
      </ScrollArea>
    </aside>
  );
}
