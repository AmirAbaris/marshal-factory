"use client";

import { GitMergeIcon } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { mergeJob } from "@/app/actions/merge";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { MergeOutcome, MergeTarget } from "@/lib/merge";
import type { JobId } from "@/lib/sources/shapes";

type Loaded = { kind: "loading" } | { kind: "ready"; target: MergeTarget } | { kind: "none" };

/** Squash-merges a job's PR at the head the owner saw when run detail opened. */
export function MergeButton({ jobId, jobKey }: { jobId: JobId; jobKey: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  // A second click can land before React re-renders the disabled button.
  const running = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/jobs/${encodeURIComponent(jobKey)}/merge-target`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ target: MergeTarget | null }>) : { target: null }))
      .then(({ target }) => setLoaded(target ? { kind: "ready", target } : { kind: "none" }))
      .catch(() => controller.signal.aborted || setLoaded({ kind: "none" }));
    return () => controller.abort();
  }, [jobKey]);

  if (loaded.kind === "none") return null;
  if (outcome?.ok) {
    return <span className="text-sm text-success">Merged · waiting for GitHub to confirm</span>;
  }

  const target = loaded.kind === "ready" ? loaded.target : null;
  const confirm = () => {
    if (!target || running.current) return;
    running.current = true;
    startTransition(async () => {
      try {
        const result = await mergeJob(jobId, target.headSha);
        setOutcome(result);
        if (result.ok) setOpen(false);
      } finally {
        running.current = false;
      }
    });
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (next) setOutcome(null);
      }}
    >
      <AlertDialogTrigger disabled={!target} render={<Button size="sm" />}>
        {target ? <GitMergeIcon data-icon="inline-start" /> : <Spinner data-icon="inline-start" />}
        Merge
      </AlertDialogTrigger>
      {target && (
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge this pull request?</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="flex flex-col gap-1.5">
              <span className="font-medium text-foreground">{target.title}</span>
              <span>
                Squashes <span className="font-mono">{target.headSha.slice(0, 7)}</span> into{" "}
                <span className="font-mono">{target.repo}</span>. A newer push since you opened this run stops the merge.
              </span>
              {target.mergeable === "conflicting" && (
                <span className="text-warning">GitHub reports a conflict with the base branch.</span>
              )}
              {outcome && !outcome.ok && (
                <span role="alert" className="text-destructive">
                  {outcome.message}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={confirm} disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              Squash and merge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}
