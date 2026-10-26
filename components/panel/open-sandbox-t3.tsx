"use client";

import { CheckIcon, CopyIcon, ExternalLinkIcon } from "lucide-react";
import { useRef, useState } from "react";
import { requestT3Pairing, takeT3Pairing } from "@/app/actions/open-t3";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { JobId } from "@/lib/sources/shapes";

const POLL_MS = 1_500;
/** The runner works one step at a time, so a busy queue can hold the request for a few minutes. */
const GIVE_UP_MS = 4 * 60_000;

type View =
  | { kind: "asking"; slow: boolean }
  | { kind: "ready"; pairUrl: string }
  | { kind: "failed"; message: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks the job's runner for a one-time pairing link to the T3 in its sandbox and shows it once.
 * The link lives only in this dialog's state; closing the dialog drops it.
 */
export function OpenSandboxT3({ jobId, className }: { jobId: JobId; className?: string }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ kind: "asking", slow: false });
  const [copied, setCopied] = useState(false);
  // Bumped on every open and close, so a poll from an earlier open stops writing state.
  const round = useRef(0);

  async function ask(mine: number) {
    const current = () => round.current === mine;
    const asked = await requestT3Pairing(jobId).catch((error: unknown) => ({ ok: false as const, message: String(error) }));
    if (!current()) return;
    if (!asked.ok) return setView({ kind: "failed", message: asked.message });
    const started = Date.now();
    while (current()) {
      await sleep(POLL_MS);
      if (!current()) return;
      const taken = await takeT3Pairing(asked.intentId).catch(() => ({ status: "pending" as const }));
      if (!current()) return;
      switch (taken.status) {
        case "pending":
          if (Date.now() - started > GIVE_UP_MS) {
            return setView({ kind: "failed", message: "The runner did not answer. Check that it is online on the Machines page, then try again." });
          }
          setView({ kind: "asking", slow: Date.now() - started > 15_000 });
          break;
        case "ready":
          return setView({ kind: "ready", pairUrl: taken.pairUrl });
        case "failed":
          return setView({ kind: "failed", message: taken.message });
        default: {
          const unhandled: never = taken;
          throw new Error(`unknown pairing status ${JSON.stringify(unhandled)}`);
        }
      }
    }
  }

  const change = (next: boolean) => {
    round.current++;
    setOpen(next);
    setCopied(false);
    setView({ kind: "asking", slow: false });
    if (next) void ask(round.current);
  };

  const copy = async (pairUrl: string) => {
    await navigator.clipboard.writeText(pairUrl);
    setCopied(true);
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <Button variant="outline" size="sm" className={className} onClick={() => change(true)}>
        Open in T3
        <ExternalLinkIcon data-icon="inline-end" />
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Open the sandbox in T3</DialogTitle>
          <DialogDescription>
            {view.kind === "ready"
              ? "Paste this link into T3 → Add environment. It works once and expires in 15 minutes."
              : "The job runs in a Modal sandbox, so T3 on your Mac connects to it with a one-time pairing link."}
          </DialogDescription>
        </DialogHeader>
        {view.kind === "asking" && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Spinner />
            {view.slow ? "Still waiting; the runner finishes its current step first." : "Asking the runner for a pairing link…"}
          </p>
        )}
        {view.kind === "ready" && (
          <div className="flex gap-2">
            <Input readOnly value={view.pairUrl} aria-label="Pairing link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button variant="outline" size="icon" aria-label="Copy pairing link" onClick={() => void copy(view.pairUrl)}>
              {copied ? <CheckIcon /> : <CopyIcon />}
            </Button>
          </div>
        )}
        {view.kind === "failed" && (
          <p role="alert" className="text-muted-foreground">
            {view.message}
          </p>
        )}
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
