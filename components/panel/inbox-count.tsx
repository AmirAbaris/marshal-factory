"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import type { JobRow } from "@/db/schema";
import { splitArchived } from "@/lib/archive";
import { inboxItems } from "@/lib/inbox";
import { useFeed, type Feed } from "./sealed";

/** How many inbox items wait on the owner, live; a dot on the icon while the rail is collapsed. */
export function InboxCount({ jobs }: { jobs: Feed<JobRow> }) {
  const { rows } = useFeed(jobs, "/api/live/jobs");
  const count = useMemo(() => inboxItems(splitArchived(rows).shown).length, [rows]);
  if (count === 0) return null;
  return (
    <>
      <Badge variant="secondary" size="sm" className="tabular-nums in-data-collapsed:hidden" aria-label={`${count} waiting on you`}>
        {count}
      </Badge>
      <span aria-hidden className="absolute top-1.5 left-6 hidden size-1.5 rounded-full bg-primary in-data-collapsed:block" />
    </>
  );
}
