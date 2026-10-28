"use client";

import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useTransition } from "react";
import { archiveJobs, unarchiveJobs } from "@/app/actions/archive";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import type { JobRow } from "@/db/schema";
import { archiveRefusal, isArchived } from "@/lib/archive";

/** Run detail's Archive for a finished job, and Unarchive once it is archived. */
export function ArchiveButton({ job }: { job: JobRow }) {
  const [pending, startTransition] = useTransition();
  const archived = isArchived(job);
  if (!archived && archiveRefusal(job)) return null;
  const act = () =>
    startTransition(async () => {
      const outcome = await (archived ? unarchiveJobs([job.id]) : archiveJobs([job.id])).catch((e: unknown) => ({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      }));
      toastManager.add({ type: outcome.ok ? "success" : "error", title: outcome.message });
    });
  return (
    <Button variant="outline" size="sm" onClick={act} loading={pending}>
      {archived ? <ArchiveRestoreIcon data-icon="inline-start" /> : <ArchiveIcon data-icon="inline-start" />}
      {archived ? "Unarchive" : "Archive"}
    </Button>
  );
}
