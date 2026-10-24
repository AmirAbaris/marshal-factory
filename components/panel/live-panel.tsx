"use client";

import { useMemo } from "react";
import type { AgentRow, EventRow, JobRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { boardCards } from "./cards";
import { attemptBranch } from "@/lib/factory";
import { groupBy, spendOf } from "./format";
import { RunDetail } from "./run-detail";
import { useFeed, type Feed } from "./sealed";
import { Sidebar } from "./sidebar";
import { StatsStrip } from "./stats-strip";
import { useAfterHydration } from "./time";

export type DetailProps = {
  sessionId: string;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
  stagesPath: string;
};

export function LivePanel({
  jobs,
  runs,
  agents,
  detail,
}: {
  jobs: Feed<JobRow>;
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  detail: DetailProps | undefined;
}) {
  const { rows: jobRows } = useFeed(jobs, "/api/live/jobs");
  const { rows: runRows, status } = useFeed(runs, "/api/live/runs");
  const { rows: agentRows } = useFeed(agents, "/api/live/agents");

  const agentsBySession = useMemo(
    () => groupBy(agentRows, (a) => a.session_id),
    [agentRows],
  );
  const cards = useMemo(() => boardCards(jobRows, runRows), [jobRows, runRows]);
  const claimed = new Set(jobRows.map((j) => j.key));
  const unstaged = runRows.filter(
    (r) => r.stage === null && !(r.job_key && claimed.has(r.job_key)),
  );
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);
  const selectedJob = selectedRun?.job_key
    ? jobRows.find((j) => j.key === selectedRun.job_key)
    : undefined;

  return (
    <div className="grid h-screen grid-cols-[220px_1fr]">
      <Sidebar
        cardCount={cards.length}
        unstagedCount={unstaged.length}
        liveSessions={runRows.filter((r) => r.status === "active").length}
        status={status}
      />
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center border-b px-5.5 py-3.5">
          <span className="text-muted-foreground">marshal /&nbsp;</span>
          <h1 className="text-sm font-semibold">Factory board</h1>
        </header>
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={`grid min-h-0 flex-1 ${selectedRun ? "grid-cols-[1fr_420px]" : "grid-cols-1"}`}>
          <Board
            cards={cards}
            unstaged={unstaged}
            agentsBySession={agentsBySession}
            selected={detail?.sessionId}
          />
          {selectedRun && detail && (
            <RunDetail
              key={detail.sessionId}
              run={selectedRun}
              agents={detail.agents}
              events={detail.events}
              stages={detail.stages}
              stagesPath={detail.stagesPath}
              job={selectedJob}
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
      </main>
    </div>
  );
}
