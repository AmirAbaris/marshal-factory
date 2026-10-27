import { cookies } from "next/headers";
import { Suspense } from "react";
import { InboxCount } from "@/components/panel/inbox-count";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import { jobsQuery, load } from "@/lib/live-queries";

async function LiveInboxCount() {
  return <InboxCount jobs={await load(jobsQuery())} />;
}

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  const collapsed = (await cookies()).get(COLLAPSED_COOKIE)?.value === "false";
  return (
    <RealtimeRoot>
      <PanelShell
        defaultCollapsed={collapsed}
        inboxCount={
          <Suspense fallback={null}>
            <LiveInboxCount />
          </Suspense>
        }
      >
        {children}
      </PanelShell>
    </RealtimeRoot>
  );
}
