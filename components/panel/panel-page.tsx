import { cookies } from "next/headers";
import { Suspense } from "react";
import { JOB_VIEW_COOKIE, parseJobView } from "@/components/panel/job-view";
import { LivePanel, type DetailProps, type PanelView } from "@/components/panel/live-panel";
import {
  agentsOverviewQuery,
  jobAuditQuery,
  jobsQuery,
  jobStagesQuery,
  load,
  machinesQuery,
  parseJobKey,
  parseSessionId,
  runJob,
  runsQuery,
  sessionAgentsQuery,
  sessionEventsQuery,
  sessionStagesQuery,
} from "@/lib/live-queries";

async function loadDetail(raw: string | undefined): Promise<DetailProps | undefined> {
  const sessionId = raw && parseSessionId(raw);
  if (!sessionId) return undefined;
  const { jobKey, jobId } = await runJob(sessionId);
  const [agents, events, stages, audit] = await Promise.all([
    load(sessionAgentsQuery(sessionId)),
    load(sessionEventsQuery(sessionId)),
    load(jobKey ? jobStagesQuery(jobKey) : sessionStagesQuery(sessionId)),
    jobId ? load(jobAuditQuery(jobId)) : undefined,
  ]);
  const stagesPath = jobKey
    ? `/api/live/jobs/${encodeURIComponent(jobKey)}/stages`
    : `/api/live/runs/${encodeURIComponent(sessionId)}/stages`;
  const auditFeed = audit && jobKey ? { feed: audit, path: `/api/live/jobs/${encodeURIComponent(jobKey)}/audit` } : undefined;
  return { sessionId, agents, events, stages, stagesPath, audit: auditFeed };
}

async function Panel({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { run, job, view: rawView } = await searchParams;
  const [jobs, runs, agents, machines, detail, jar] = await Promise.all([
    load(jobsQuery()),
    load(runsQuery()),
    load(agentsOverviewQuery()),
    load(machinesQuery()),
    loadDetail(typeof run === "string" ? run : undefined),
    cookies(),
  ]);
  const jobView = parseJobView(rawView) ?? parseJobView(jar.get(JOB_VIEW_COOKIE)?.value) ?? "board";
  return (
    <LivePanel
      view={view}
      jobView={jobView}
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
