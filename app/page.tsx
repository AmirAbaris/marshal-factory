import { Suspense } from "react";
import { LivePanel, type DetailProps } from "@/components/panel/live-panel";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import {
  agentsOverviewQuery,
  jobsQuery,
  jobStagesQuery,
  load,
  parseSessionId,
  runJobKey,
  runsQuery,
  sessionAgentsQuery,
  sessionEventsQuery,
  sessionStagesQuery,
} from "@/lib/live-queries";

async function loadDetail(raw: string | undefined): Promise<DetailProps | undefined> {
  const sessionId = raw && parseSessionId(raw);
  if (!sessionId) return undefined;
  const jobKey = await runJobKey(sessionId);
  const [agents, events, stages] = await Promise.all([
    load(sessionAgentsQuery(sessionId)),
    load(sessionEventsQuery(sessionId)),
    load(jobKey ? jobStagesQuery(jobKey) : sessionStagesQuery(sessionId)),
  ]);
  const stagesPath = jobKey
    ? `/api/live/jobs/${encodeURIComponent(jobKey)}/stages`
    : `/api/live/runs/${encodeURIComponent(sessionId)}/stages`;
  return { sessionId, agents, events, stages, stagesPath };
}

async function Panel({ searchParams }: Pick<PageProps<"/">, "searchParams">) {
  const { run } = await searchParams;
  const [jobs, runs, agents, detail] = await Promise.all([
    load(jobsQuery()),
    load(runsQuery()),
    load(agentsOverviewQuery()),
    loadDetail(typeof run === "string" ? run : undefined),
  ]);
  return (
    <RealtimeRoot>
      <LivePanel jobs={jobs} runs={runs} agents={agents} detail={detail} />
    </RealtimeRoot>
  );
}

export default function Home(props: PageProps<"/">) {
  return (
    <Suspense fallback={<div className="h-screen" />}>
      <Panel searchParams={props.searchParams} />
    </Suspense>
  );
}
