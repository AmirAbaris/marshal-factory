"use client";

import type { AuditRow } from "@/db/schema";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useFeed, type Feed } from "./sealed";
import { Time } from "./time";

const ACTION: Record<AuditRow["action"], { label: string; tone: string }> = {
  merge_requested: { label: "Merge requested", tone: "text-foreground" },
  merge_succeeded: { label: "Merged", tone: "text-success" },
  merge_failed: { label: "Merge failed", tone: "text-destructive" },
};

const RESULT: Record<NonNullable<AuditRow["result"]>, string> = {
  ok: "ok",
  head_moved: "head moved",
  not_mergeable: "not mergeable",
  refused: "refused",
  error: "error",
};

/** The job's audit rows, newest first: who asked, when, for which commit, and what came of it. */
export function AuditLog({ feed, path }: { feed: Feed<AuditRow>; path: string }) {
  const { rows } = useFeed(feed, path);
  if (rows.length === 0) return null;
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">Merges</h3>
        <ol className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={cn("font-medium", ACTION[row.action].tone)}>{ACTION[row.action].label}</span>
                {row.result && row.result !== "ok" && <span className="text-muted-foreground">{RESULT[row.result]}</span>}
                <span className="font-mono text-xs text-faint">{row.head_sha.slice(0, 7)}</span>
                <span className="ml-auto text-xs text-faint">
                  <Time date={row.at} />
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                {row.actor}
                {row.detail && ` · ${row.detail}`}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
