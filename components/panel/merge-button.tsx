"use client";

import { GitMergeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { approveFromRunDetail } from "@/app/actions/inbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import type { MergeTarget } from "@/lib/inbox-actions";
import type { JobId } from "@/lib/sources/shapes";
import { useInboxAction, Waiting } from "./inbox-actions";

type Loaded = { kind: "loading" } | { kind: "ready"; target: MergeTarget } | { kind: "none" };

/**
 * Approves the job's PR for the runner to merge, at the head the owner saw when run detail opened:
 * the inbox's approval, so the merge goes through the runner's merge service. The dialog stays
 * open until the runner merges it or says why not.
 */
export function MergeButton({ jobId, jobKey }: { jobId: JobId; jobKey: string }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useInboxAction();

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/jobs/${encodeURIComponent(jobKey)}/merge-target`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ target: MergeTarget | null }>) : { target: null }))
      .then(({ target }) => setLoaded(target ? { kind: "ready", target } : { kind: "none" }))
      .catch(() => controller.signal.aborted || setLoaded({ kind: "none" }));
    return () => controller.abort();
  }, [jobKey]);

  if (loaded.kind === "none") return null;
  const target = loaded.kind === "ready" ? loaded.target : null;
  const merging = busy !== null;
  const confirm = () => {
    if (!target) return;
    void run("approve", () => approveFromRunDetail(jobId, crypto.randomUUID(), target.headSha), "Merged.", () => setOpen(false));
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => merging || setOpen(next)}>
      <AlertDialogTrigger disabled={!target} render={<Button size="sm" loading={merging} />}>
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
                The factory merges <span className="font-mono">{target.headSha.slice(0, 7)}</span> into <span className="font-mono">{target.repo}</span> the way
                it merges on its own, then watches main. A newer push, a red or running check, a conflict or a branch behind its base still stops it.
              </span>
              {target.mergeable === "conflicting" && <span className="text-warning">GitHub reports a conflict with the base branch.</span>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {(busy || error) && (
            <div className="flex flex-col gap-3 px-6 pb-6">
              <Waiting busy={busy} />
              {error && (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogClose disabled={merging} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button onClick={confirm} loading={merging}>
              Merge
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}
