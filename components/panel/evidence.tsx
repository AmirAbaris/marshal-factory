"use client";

import { CheckIcon, ShieldCheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { JobEvidenceRow, JobRow } from "@/db/schema";
import { CHECK_NAME_LABELS, formatDuration, parseSummary, PRODUCER_LABELS, shortSha, type EvidenceCheck, type EvidenceLine as Line, type EvidenceSummary } from "@/lib/evidence";
import { cn } from "@/lib/utils";
import { jobEvidenceLine, shownDecision } from "./cards";
import { useFeed, type Feed } from "./sealed";
import { Time } from "./time";

const TONE: Record<Line["tone"], string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/** The one line a card shows apart from its stage: verified at which commit, or not at the head. */
export function EvidenceLine({ line, className }: { line: Line; className?: string }) {
  const Icon = line.tone === "success" ? ShieldCheckIcon : ShieldAlertIcon;
  return (
    <p className={cn("flex items-center gap-1 text-xs", TONE[line.tone], className)}>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{line.text}</span>
    </p>
  );
}

type CheckRow = Pick<EvidenceCheck, "name" | "passed" | "exitCode" | "durationMs"> & Partial<Pick<EvidenceCheck, "command" | "outputTail">>;

function CheckItem({ check }: { check: CheckRow }) {
  const meta = [formatDuration(check.durationMs), !check.passed && (check.exitCode === null ? "no exit code" : `exit ${check.exitCode}`)].filter(Boolean).join(" · ");
  const head = (
    <div className="flex min-w-0 items-baseline gap-2">
      {check.passed ? <CheckIcon className="size-3.5 shrink-0 self-center text-success" /> : <XIcon className="size-3.5 shrink-0 self-center text-destructive" />}
      <span className="font-medium">{CHECK_NAME_LABELS[check.name]}</span>
      {check.command && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{check.command}</span>}
      <span className="ml-auto shrink-0 text-xs text-faint tabular-nums">{meta}</span>
    </div>
  );
  if (!check.outputTail) return <li>{head}</li>;
  return (
    <li>
      <details open={!check.passed} className="group">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{head}</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">{check.outputTail}</pre>
      </details>
    </li>
  );
}

function provenance(row: { producer: EvidenceSummary["producer"]; source: EvidenceSummary["source"]; clean: boolean }) {
  return [`Run by ${PRODUCER_LABELS[row.producer]}`, row.source === "recipe" ? "recipe checks" : row.source === "package" ? "package.json scripts" : "no checks found", !row.clean && "uncommitted changes, so it proves nothing about the commit"]
    .filter(Boolean)
    .join(" · ");
}

/** Run detail's evidence: every commit the job's checks ran at, newest first, with each check's output. */
export function EvidenceSection({ feed, path, job }: { feed: Feed<JobEvidenceRow>; path: string; job: JobRow }) {
  const { rows } = useFeed(feed, path);
  const line = jobEvidenceLine(job);
  const head = shownDecision(job)?.headSha ?? null;
  const attemptRows = rows.filter((r) => r.attempt === job.attempt);
  if (!line && attemptRows.length === 0) return null;
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5 text-sm">
        <h3 className="text-sm font-medium text-muted-foreground">Evidence</h3>
        {line && <EvidenceLine line={line} className="text-sm" />}
        {attemptRows.length === 0 && <p className="text-muted-foreground">No checks were reported for this attempt yet.</p>}
        <ol className="flex flex-col gap-3">
          {attemptRows.map((row) => (
            <li key={row.sha} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono text-xs">{shortSha(row.sha)}</span>
                {head === row.sha && <span className="text-xs text-muted-foreground">PR head</span>}
                <span className="ml-auto text-xs text-faint">
                  <Time date={row.recorded_at} />
                </span>
              </div>
              <p className={cn("text-xs", row.clean ? "text-muted-foreground" : "text-warning")}>{provenance(row)}</p>
              <ul className="flex flex-col gap-1">
                {row.checks.map((check, i) => (
                  <CheckItem key={`${check.name}-${i}`} check={check} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

/** The inbox's evidence: the latest commit's checks, without output, held against the PR head. */
export function EvidenceSummaryList({ job }: { job: JobRow }) {
  const line = jobEvidenceLine(job);
  const summary = parseSummary(job.evidence);
  const current = summary?.attempt === job.attempt ? summary : null;
  if (!line) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <EvidenceLine line={line} className="text-sm" />
      {current && (
        <>
          <p className="text-xs text-muted-foreground">
            {provenance(current)} · at <span className="font-mono">{shortSha(current.sha)}</span> <Time date={new Date(current.at)} />
          </p>
          <ul className="flex flex-col gap-1">
            {current.checks.map((check, i) => (
              <CheckItem key={`${check.name}-${i}`} check={check} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
