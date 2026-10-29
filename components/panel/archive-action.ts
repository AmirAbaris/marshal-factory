"use client";

import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useTransition } from "react";
import { archiveJobs, unarchiveJobs } from "@/app/actions/archive";
import { toastManager } from "@/components/ui/toast";
import type { JobRow } from "@/db/schema";
import { archiveRefusal, isArchived } from "@/lib/archive";

export type ArchiveAction = NonNullable<ReturnType<typeof useArchiveAction>>;

/** Archive for a finished job, and Unarchive once it is archived; null while the job can be neither. */
export function useArchiveAction(job: JobRow) {
  const [pending, startTransition] = useTransition();
  const archived = isArchived(job);
  const act = () =>
    startTransition(async () => {
      const outcome = await (archived ? unarchiveJobs([job.id]) : archiveJobs([job.id])).catch((e: unknown) => ({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      }));
      toastManager.add({ type: outcome.ok ? "success" : "error", title: outcome.message });
    });
  if (!archived && archiveRefusal(job)) return null;
  return { archived, pending, act, label: archived ? "Unarchive" : "Archive", Icon: archived ? ArchiveRestoreIcon : ArchiveIcon };
}
