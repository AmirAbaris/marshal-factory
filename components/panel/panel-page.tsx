import { cookies } from "next/headers";
import { Suspense } from "react";
import { JOB_VIEW_COOKIE, parseJobView } from "@/components/panel/job-view";
import { LivePanel, type DetailProps, type PanelView } from "@/components/panel/live-panel";
import { db } from "@/db/client";
import {
  agentsOverviewQuery,
  jobAuditQuery,
  jobEvidenceQuery,
  jobsQuery,
  jobStagesQuery,
  load,
  machinesQuery,
  parseJobKey,
  runJob,
  runsQuery,
  sessionAgentsQuery,
  sessionEventsQuery,
  sessionStagesQuery,
} from "@/lib/live-queries";
import { REPO_FILTER_COOKIE, repoFilter } from "@/lib/repo-filter";
import { parseSessionId, runFeedPath } from "@/lib/run-links";
import { readRegistry } from "@/lib/repositories";

async function loadDetail(raw: string | undefined): Promise<DetailProps | undefined> {
  const sessionId = parseSessionId(raw);
  if (!sessionId) return undefined;
  const { jobKey, jobId } = await runJob(sessionId);
  const [agents, events, stages, audit, evidence] = await Promise.all([
    load(sessionAgentsQuery(sessionId)),
    load(sessionEventsQuery(sessionId)),
    load(jobKey ? jobStagesQuery(jobKey) : sessionStagesQuery(sessionId)),
    jobId ? load(jobAuditQuery(jobId)) : undefined,
    jobId && jobKey ? load(jobEvidenceQuery(jobKey)) : undefined,
  ]);
  const stagesPath = jobKey
    ? `/api/live/jobs/${encodeURIComponent(jobKey)}/stages`
    : runFeedPath("stages", sessionId);
  const auditFeed = audit && jobKey ? { feed: audit, path: `/api/live/jobs/${encodeURIComponent(jobKey)}/audit` } : undefined;
  const evidenceFeed = evidence && jobKey ? { feed: evidence, path: `/api/live/jobs/${encodeURIComponent(jobKey)}/evidence` } : undefined;
  return { sessionId, agents, events, stages, stagesPath, audit: auditFeed, evidence: evidenceFeed };
}

async function Panel({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { run, job, view: rawView, repo, archived } = await searchParams;
  const [jobs, runs, agents, machines, detail, jar] = await Promise.all([
    load(jobsQuery()),
    load(runsQuery()),
    load(agentsOverviewQuery()),
    load(machinesQuery()),
    loadDetail(typeof run === "string" ? run : undefined),
    cookies(),
  ]);
  const jobView = parseJobView(rawView) ?? parseJobView(jar.get(JOB_VIEW_COOKIE)?.value) ?? "board";
  // After the loads, which check the owner.
  const registry = await readRegistry(db);
  return (
    <LivePanel
      view={view}
      jobView={jobView}
      repo={repoFilter(repo, jar.get(REPO_FILTER_COOKIE)?.value)}
      archived={view === "jobs" && archived === "1"}
      registry={registry.map((r) => ({ repo: r.repo, display_name: r.display_name, enabled: r.enabled, is_default: r.is_default }))}
      jobs={jobs}
      runs={runs}
      agents={agents}
      machines={machines}
      detail={detail}
      inboxKey={typeof job === "string" ? parseJobKey(job) : undefined}
    />
  );
}

/** The inbox, the jobs page (board or list) and the other-activity page share their data, their live feeds and run detail. */
export function PanelPage({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <Panel view={view} searchParams={searchParams} />
    </Suspense>
  );
}
