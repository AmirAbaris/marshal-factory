"use client";

import { InboxIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import type { AgentRow, AuditRow, EventRow, JobRow, MachineRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { boardCards } from "./cards";
import { sandboxState } from "@/lib/execution";
import { attemptBranch } from "@/lib/factory";
import { inboxItems } from "@/lib/inbox";
import { reportedHarnesses } from "@/lib/machine";
import { cn } from "@/lib/utils";
import { groupBy, spendOf } from "./format";
import { Inbox } from "./inbox";
import { JobList } from "./job-list";
import { NewJobButton } from "./new-job-button";
import { OtherActivity } from "./other-activity";
import { RunDetail } from "./run-detail";
import { useFeed, type Feed } from "./sealed";
import { PanelFooter, PanelHeader, type KeyHint } from "./panel-header";
import { StatsStrip } from "./stats-strip";
import { useAfterHydration } from "./time";

export type DetailProps = {
  sessionId: string;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
  stagesPath: string;
  /** Present when the run belongs to a job. */
  audit: { feed: Feed<AuditRow>; path: string } | undefined;
};

export type PanelView = "inbox" | "board" | "list" | "activity";

const LIST_KEYS: readonly KeyHint[] = [
  { keys: ["J", "K"], label: "move" },
  { keys: ["↵"], label: "open" },
  { keys: ["Esc"], label: "close" },
];

function viewMeta(view: PanelView) {
  switch (view) {
    case "inbox":
      return { title: "Inbox", job: false };
    case "board":
      return { title: "Board", job: true };
    case "list":
      return { title: "List", job: true };
    case "activity":
      return { title: "Other activity", job: false };
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function footerSummary(view: PanelView, counts: { jobs: number; sessions: number; inbox: number }) {
  switch (view) {
    case "inbox":
      return counts.inbox === 0 ? "Nothing waiting" : `${plural(counts.inbox, "item", "items")} waiting on you`;
    case "board":
    case "list":
      return plural(counts.jobs, "job", "jobs");
    case "activity":
      return plural(counts.sessions, "session", "sessions");
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

export function LivePanel({
  view,
  jobs,
  runs,
  agents,
  machines,
  detail,
  inboxKey,
}: {
  view: PanelView;
  /** The inbox item open on the right, by job key. */
  inboxKey: string | undefined;
  jobs: Feed<JobRow>;
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  machines: Feed<MachineRow>;
  detail: DetailProps | undefined;
}) {
  const { rows: jobRows } = useFeed(jobs, "/api/live/jobs");
  const { rows: runRows, status } = useFeed(runs, "/api/live/runs");
  const { rows: agentRows } = useFeed(agents, "/api/live/agents");
  const { rows: machineRows } = useFeed(machines, "/api/live/machines");
  const machineById = useMemo(() => new Map(machineRows.map((m) => [m.id, m])), [machineRows]);

  const agentsBySession = useMemo(
    () => groupBy(agentRows, (a) => a.session_id),
    [agentRows],
  );
  const harnesses = useMemo(() => reportedHarnesses(machineRows, 0) ?? [], [machineRows]);
  const enabledHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);
  const cards = useMemo(() => boardCards(jobRows, runRows, harnesses), [jobRows, runRows, harnesses]);
  const unstaged = useMemo(() => {
    const claimed = new Set(jobRows.map((j) => j.key));
    return runRows.filter((r) => r.stage === null && !(r.job_key && claimed.has(r.job_key)));
  }, [jobRows, runRows]);
  const sandboxNote = useMemo(() => {
    const states = jobRows.map(sandboxState);
    const running = states.filter((s) => s === "running").length;
    const hibernated = states.filter((s) => s === "hibernated").length;
    if (running + hibernated === 0) return null;
    return `${running} in sandboxes${hibernated > 0 ? `, ${hibernated} hibernated` : ""}`;
  }, [jobRows]);
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);
  const selectedJob = selectedRun?.job_key
    ? jobRows.find((j) => j.key === selectedRun.job_key)
    : undefined;

  const inboxCount = useMemo(() => inboxItems(jobRows).length, [jobRows]);

  const meta = viewMeta(view);
  const active = runRows.filter((r) => r.status === "active").length;
  const content = (() => {
    switch (view) {
      case "inbox":
        return <Inbox jobs={jobRows} cards={cards} selected={inboxKey} />;
      case "board":
        return <Board cards={cards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} />;
      case "list":
        return <JobList cards={cards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} />;
      case "activity":
        return <OtherActivity runs={unstaged} agentsBySession={agentsBySession} selected={detail?.sessionId} />;
      default: {
        const never: never = view;
        throw new Error(`unknown view ${String(never)}`);
      }
    }
  })();

  return (
    <>
      <PanelHeader
        title={meta.title}
        view={view === "board" || view === "list" ? view : undefined}
        actions={
          meta.job ? (
            <>
              {inboxCount > 0 && (
                <Button render={<Link href="/inbox" />} variant="ghost" size="sm" className="text-muted-foreground">
                  <InboxIcon data-icon="inline-start" />
                  {inboxCount} {inboxCount === 1 ? "needs" : "need"} you
                </Button>
              )}
              <NewJobButton harnesses={enabledHarnesses} />
            </>
          ) : undefined
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={cn("grid min-h-0 flex-1", selectedRun ? "grid-cols-[1fr_420px]" : "grid-cols-1")}>
          {content}
          {selectedRun && detail && (
            <RunDetail
              key={detail.sessionId}
              run={selectedRun}
              agents={detail.agents}
              events={detail.events}
              stages={detail.stages}
              stagesPath={detail.stagesPath}
              audit={detail.audit}
              job={selectedJob}
              machine={selectedJob?.machine_id ? machineById.get(selectedJob.machine_id) : undefined}
              harnesses={harnesses}
              jobSpend={
                selectedJob
                  ? {
                      usd: spendOf(
                        runRows.filter((r) => r.branch === attemptBranch(selectedJob.key, selectedJob.attempt)),
                        agentsBySession,
                      ),
                      capUsd: selectedJob.budget_usd,
                      attempt: selectedJob.attempt,
                    }
                  : undefined
              }
            />
          )}
        </div>
      </div>
      <PanelFooter
        status={status}
        note={[`${active} active`, sandboxNote].filter(Boolean).join(" · ")}
        summary={footerSummary(view, { jobs: cards.length, sessions: unstaged.length, inbox: inboxCount })}
        keys={view === "list" || view === "inbox" ? LIST_KEYS : undefined}
      />
    </>
  );
}
