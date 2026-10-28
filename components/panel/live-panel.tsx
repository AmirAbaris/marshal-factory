"use client";

import { InboxIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { startTransition, useMemo, useOptimistic } from "react";
import { Button } from "@/components/ui/button";
import type { AgentRow, AuditRow, EventRow, JobEvidenceRow, JobRow, MachineRow, RepoSettingsRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { boardCards } from "./cards";
import { sandboxState } from "@/lib/execution";
import { attemptBranch } from "@/lib/factory";
import { inboxItems } from "@/lib/inbox";
import { reportedHarnesses } from "@/lib/machine";
import { cn } from "@/lib/utils";
import { groupBy, spendOf } from "./format";
import { Inbox } from "./inbox";
import { useFullView } from "./full-view";
import { JobList } from "./job-list";
import { JOB_VIEW_COOKIE, jobsHref, type JobView } from "./job-view";
import { NewJobButton } from "./new-job-button";
import { OtherActivity } from "./other-activity";
import { RunDetail } from "./run-detail";
import { useFeed, type Feed } from "./sealed";
import { PanelFooter, PanelHeader, type KeyHint } from "./panel-header";
import { RepoSelect, repoOptions, useRepoFilter, useRepoLabels } from "./repo-filter";
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
  /** The job's evidence per commit; present when the run belongs to a job. */
  evidence: { feed: Feed<JobEvidenceRow>; path: string } | undefined;
};

export type PanelView = "inbox" | "jobs" | "activity";

/** What the jobs page and the inbox need of each registered repo. */
export type PanelRepo = Pick<RepoSettingsRow, "repo" | "display_name" | "enabled" | "is_default">;

const LIST_KEYS: readonly KeyHint[] = [
  { keys: ["J", "K"], label: "move" },
  { keys: ["↵"], label: "open" },
  { keys: ["Esc"], label: "close" },
];

const FULL_VIEW_KEYS: readonly KeyHint[] = [{ keys: ["Esc"], label: "side panel" }];

function viewMeta(view: PanelView) {
  switch (view) {
    case "inbox":
      return { title: "Inbox", job: false };
    case "jobs":
      return { title: "Jobs", job: true };
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
    case "jobs":
      return plural(counts.jobs, "job", "jobs");
    case "activity":
      return plural(counts.sessions, "session", "sessions");
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

/** Where closing the run detail goes: the same page, in the same layout. */
function closeHref(view: PanelView, jobView: JobView) {
  switch (view) {
    case "inbox":
      return "/inbox";
    case "jobs":
      return jobsHref(jobView);
    case "activity":
      return "/activity";
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

/** The jobs page's board or list. Switching keeps the page mounted, so the live feeds stay subscribed. */
function useJobView(current: JobView) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [jobView, setOptimistic] = useOptimistic(current);
  const switchTo = (next: JobView) => {
    document.cookie = `${JOB_VIEW_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}`;
    const params = new URLSearchParams(searchParams);
    params.set("view", next);
    startTransition(() => {
      setOptimistic(next);
      router.replace(`/?${params}`, { scroll: false });
    });
  };
  return [jobView, switchTo] as const;
}

export function LivePanel({
  view,
  jobView: currentJobView,
  repo: currentRepo,
  registry,
  jobs,
  runs,
  agents,
  machines,
  detail,
  inboxKey,
}: {
  view: PanelView;
  /** The jobs page's layout, from ?view or the remembered one. */
  jobView: JobView;
  /** The repo the jobs page and the inbox show, from ?repo or the remembered one; null shows all. */
  repo: string | null;
  registry: readonly PanelRepo[];
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
  const fullView = useFullView();
  const [jobView, switchJobView] = useJobView(currentJobView);

  // The filter applies to the loaded feeds; the inbox count stays global.
  const options = useMemo(() => repoOptions(registry, jobRows), [registry, jobRows]);
  const repoLabels = useRepoLabels(options);
  const [repoChoice, pickRepo] = useRepoFilter(currentRepo);
  const repo = options.some((o) => o.repo === repoChoice) ? repoChoice : null;
  const shownJobs = useMemo(() => (repo ? jobRows.filter((j) => j.repo === repo) : jobRows), [jobRows, repo]);
  const shownCards = useMemo(() => (repo ? cards.filter((c) => c.repo === repo) : cards), [cards, repo]);
  const shownInbox = useMemo(() => (repo ? inboxItems(shownJobs).length : inboxCount), [repo, shownJobs, inboxCount]);
  const inboxOpen = useMemo(
    () => view === "inbox" && inboxKey !== undefined && inboxItems(shownJobs).some((i) => i.job.key === inboxKey),
    [view, inboxKey, shownJobs],
  );
  const runFull = fullView.full && selectedRun !== undefined;
  const repoSelect = options.length > 0 && <RepoSelect options={options} value={repo} onChange={pickRepo} />;

  const meta = viewMeta(view);
  const active = runRows.filter((r) => r.status === "active").length;
  const content = (() => {
    switch (view) {
      case "inbox":
        return <Inbox jobs={shownJobs} cards={cards} selected={inboxKey} repoLabels={repoLabels} fullView={fullView} />;
      case "jobs":
        return jobView === "board" ? (
          <Board cards={shownCards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} repoLabels={repoLabels} />
        ) : (
          <JobList cards={shownCards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} repoLabels={repoLabels} />
        );
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
        jobView={view === "jobs" ? { current: jobView, onChange: switchJobView } : undefined}
        actions={
          meta.job ? (
            <>
              {repoSelect}
              {inboxCount > 0 && (
                <Button render={<Link href="/inbox" />} variant="ghost" size="sm" className="text-muted-foreground">
                  <InboxIcon data-icon="inline-start" />
                  {inboxCount} {inboxCount === 1 ? "needs" : "need"} you
                </Button>
              )}
              <NewJobButton harnesses={enabledHarnesses} repos={registry} />
            </>
          ) : view === "inbox" ? (
            repoSelect
          ) : undefined
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={cn("grid min-h-0 flex-1", selectedRun && !runFull ? "grid-cols-[1fr_420px]" : "grid-cols-1")}>
          {!runFull && content}
          {selectedRun && detail && (
            <RunDetail
              key={detail.sessionId}
              run={selectedRun}
              agents={detail.agents}
              events={detail.events}
              stages={detail.stages}
              stagesPath={detail.stagesPath}
              audit={detail.audit}
              evidence={detail.evidence}
              closeHref={closeHref(view, jobView)}
              fullView={fullView}
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
        summary={footerSummary(view, { jobs: shownCards.length, sessions: unstaged.length, inbox: shownInbox })}
        keys={
          fullView.full && (selectedRun || inboxOpen)
            ? FULL_VIEW_KEYS
            : (view === "jobs" && jobView === "list") || view === "inbox"
              ? LIST_KEYS
              : undefined
        }
      />
    </>
  );
}
