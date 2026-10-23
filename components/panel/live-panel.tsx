"use client";

import { useLiveQuery } from "@neon/realtime-react";
import { useCallback, useMemo, useState } from "react";
import type { AgentRow, EventRow, IssueRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { boardCards } from "./cards";
import { attemptBranch } from "@/lib/factory";
import { groupBy, spendOf } from "./format";
import { RunDetail } from "./run-detail";
import { fetchSealed, type Feed } from "./sealed";
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
  issues,
  runs,
  agents,
  detail,
  budgetUsd,
}: {
  budgetUsd: number;
  issues: Feed<IssueRow>;
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  detail: DetailProps | undefined;
}) {
  const [issuesQuery] = useState(issues.sealedQuery);
  const [runsQuery] = useState(runs.sealedQuery);
  const [agentsQuery] = useState(agents.sealedQuery);
  const refreshIssues = useCallback(() => fetchSealed<IssueRow>("/api/live/issues"), []);
  const refreshRuns = useCallback(() => fetchSealed<RunRow>("/api/live/runs"), []);
  const refreshAgents = useCallback(() => fetchSealed<AgentRow>("/api/live/agents"), []);

  const liveIssues = useLiveQuery(issuesQuery, { refreshQuery: refreshIssues, initialData: issues.initialData });
  const liveRuns = useLiveQuery(runsQuery, { refreshQuery: refreshRuns, initialData: runs.initialData });
  const liveAgents = useLiveQuery(agentsQuery, { refreshQuery: refreshAgents, initialData: agents.initialData });
  const issueRows = liveIssues.data ?? issues.initialData;
  const runRows = liveRuns.data ?? runs.initialData;
  const agentRows = liveAgents.data ?? agents.initialData;

  const agentsBySession = useMemo(
    () => groupBy(agentRows, (a) => a.session_id),
    [agentRows],
  );
  const cards = useMemo(() => boardCards(issueRows, runRows), [issueRows, runRows]);
  const claimed = new Set(issueRows.map((i) => i.key));
  const unstaged = runRows.filter(
    (r) => r.stage === null && !(r.issue_key && claimed.has(r.issue_key)),
  );
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);
  const selectedIssue = selectedRun?.issue_key
    ? issueRows.find((i) => i.key === selectedRun.issue_key)
    : undefined;

  return (
    <div className="grid h-screen grid-cols-[220px_1fr]">
      <Sidebar
        cardCount={cards.length}
        unstagedCount={unstaged.length}
        liveSessions={runRows.filter((r) => r.status === "active").length}
        connected={liveRuns.status === "live"}
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
            budgetUsd={budgetUsd}
          />
          {selectedRun && detail && (
            <RunDetail
              key={detail.sessionId}
              run={selectedRun}
              agents={detail.agents}
              events={detail.events}
              stages={detail.stages}
              stagesPath={detail.stagesPath}
              issue={selectedIssue}
              issueSpend={
                selectedIssue
                  ? {
                      usd: spendOf(
                        runRows.filter((r) => r.branch === attemptBranch(selectedIssue.key, selectedIssue.attempt)),
                        agentsBySession,
                      ),
                      capUsd: budgetUsd,
                      attempt: selectedIssue.attempt,
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
