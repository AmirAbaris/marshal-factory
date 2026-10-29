"use client";

import { FilePlusIcon, GitMergeIcon, MessageSquareReplyIcon, OctagonXIcon, SendIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { answerQuestion, approveMerge, closeJob, dismissJob, fileFollowUp, inboxIntentOutcome, requestChanges, retryStop } from "@/app/actions/inbox";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import type { JobRow } from "@/db/schema";
import { followUpHint, INBOX_ACTIONS, MAX_FEEDBACK_CHARS, MAX_FOLLOW_UP_CHARS, type InboxAction, type InboxKind } from "@/lib/inbox";
import type { InboxOutcome, IntentOutcome } from "@/lib/inbox-actions";
import type { MergeDecision } from "@/lib/merge-decision";

const POLL_MS = 1_500;
/** The runner works one step at a time, so a busy queue can hold a request for a few minutes. */
const GIVE_UP_MS = 4 * 60_000;
const SLOW_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Busy = { action: InboxAction; slow: boolean };

/**
 * Runs one inbox action at a time: records it, then follows the runner's intent until it is
 * handled. Success is a toast; a refusal stays inline until the next try. Run detail's Merge
 * follows its approval the same way.
 */
export function useInboxAction() {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A second click can land before React re-renders the disabled button.
  const running = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function follow(intentId: string): Promise<IntentOutcome> {
    const started = Date.now();
    while (mounted.current) {
      await sleep(POLL_MS);
      const outcome = await inboxIntentOutcome(intentId).catch((): IntentOutcome => ({ status: "pending" }));
      if (outcome.status !== "pending") return outcome;
      if (Date.now() - started > GIVE_UP_MS) {
        return { status: "failed", message: "The runner hasn't picked this up yet. Check that it is online on the Machines page; it acts on the request once it is." };
      }
      if (mounted.current && Date.now() - started > SLOW_MS) setBusy((b) => b && { ...b, slow: true });
    }
    return { status: "pending" };
  }

  async function run(action: InboxAction, send: () => Promise<InboxOutcome>, done: string, onDone?: () => void) {
    if (running.current) return;
    running.current = true;
    setBusy({ action, slow: false });
    setError(null);
    try {
      const sent = await send().catch((e: unknown): InboxOutcome => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
      if (!sent.ok) return setError(sent.message);
      const outcome: IntentOutcome = sent.intentId ? await follow(sent.intentId) : { status: "done", message: sent.message ?? done };
      if (!mounted.current) {
        // The item left the inbox, which is how success usually looks; say so anyway.
        if (outcome.status === "done") toastManager.add({ type: "success", title: outcome.message });
        return;
      }
      switch (outcome.status) {
        case "done":
          toastManager.add({ type: "success", title: outcome.message });
          onDone?.();
          return;
        case "failed":
          return setError(outcome.message);
        case "pending":
          return;
        default: {
          const never: never = outcome;
          throw new Error(`unknown outcome ${JSON.stringify(never)}`);
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  return { busy, error, run };
}

export function Waiting({ busy }: { busy: Busy | null }) {
  if (!busy) return null;
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
      <Spinner className="size-3" />
      {busy.slow ? "Still waiting; the runner finishes its current step first." : "Waiting for the runner…"}
    </p>
  );
}

/** A textarea that sends with ⌘↵ and says what it sends. */
function Compose({
  label,
  description,
  placeholder,
  initial = "",
  maxLength = MAX_FEEDBACK_CHARS,
  submit,
  icon,
  disabled,
  loading,
  onSend,
}: {
  label: string;
  description: string;
  placeholder: string;
  /** Text the box starts with, for the owner to edit. */
  initial?: string;
  maxLength?: number;
  submit: string;
  icon: ReactNode;
  disabled: boolean;
  loading: boolean;
  onSend: (text: string, clear: () => void) => void;
}) {
  const [text, setText] = useState(initial);
  const send = () => text.trim() && onSend(text, () => setText(""));
  return (
    <Field className="w-full">
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex w-full items-center gap-3">
        <FieldDescription className="min-w-0 flex-1">{description}</FieldDescription>
        <Button size="sm" variant="outline" disabled={disabled || !text.trim()} loading={loading} onClick={send}>
          {icon}
          {submit}
          <Kbd className="ms-1 hidden sm:inline-flex">⌘↵</Kbd>
        </Button>
      </div>
    </Field>
  );
}

function ApproveButton({ job, headSha, disabled, loading, onApprove }: { job: JobRow; headSha: string | null; disabled: boolean; loading: boolean; onApprove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={disabled} render={<Button size="sm" loading={loading} />}>
        <GitMergeIcon data-icon="inline-start" />
        Approve and merge
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve and merge this pull request?</AlertDialogTitle>
          <AlertDialogDescription render={<div />} className="flex flex-col gap-1.5">
            <span className="font-medium text-foreground">{job.title}</span>
            <span>
              The factory merges {headSha ? <span className="font-mono">{headSha.slice(0, 7)}</span> : "the latest commit"} into{" "}
              <span className="font-mono">{job.repo}</span> the way it merges on its own, then watches main. A newer push, a red or running check, a conflict, or
              GitHub refusing the merge still stops it.
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            onClick={() => {
              setOpen(false);
              onApprove();
            }}
          >
            Approve and merge
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function CloseButton({ job, kind, disabled, loading, onClose }: { job: JobRow; kind: InboxKind; disabled: boolean; loading: boolean; onClose: (reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const failing = kind !== "failed";
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger disabled={disabled} render={<Button size="sm" variant="destructive-outline" loading={loading} />}>
        <XIcon data-icon="inline-start" />
        Close
      </AlertDialogTrigger>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {job.key}?</AlertDialogTitle>
          <AlertDialogDescription>
            {failing
              ? "Closes the pull request without merging, stops the agent and marks the job failed. Adding the factory label again retries it as a new attempt."
              : "Closes the pull request if it is still open and takes the job out of the inbox."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="px-6 pb-6">
          <Field>
            <FieldLabel>Reason (optional)</FieldLabel>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} placeholder="Why it's closed, for the job's history" />
          </Field>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              setOpen(false);
              onClose(reason);
            }}
          >
            Close the job
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** The actions an inbox item offers, each recorded for the job's runner. */
export function InboxActions({
  job,
  kind,
  decision,
  headSha,
  reviewReady,
}: {
  job: JobRow;
  kind: InboxKind;
  decision: MergeDecision | null;
  headSha: string | null;
  reviewReady: boolean;
}) {
  const { busy, error, run } = useInboxAction();
  const actions: readonly InboxAction[] = INBOX_ACTIONS[kind];
  const has = (a: InboxAction) => actions.includes(a);
  const disabled = busy !== null;
  const loading = (a: InboxAction) => busy?.action === a;
  const requestId = () => crypto.randomUUID();

  const buttons = (
    <div className="flex flex-wrap items-center gap-2">
      {has("approve") && (
        <ApproveButton
          job={job}
          headSha={headSha}
          disabled={disabled || !reviewReady}
          loading={loading("approve")}
          onApprove={() => void run("approve", () => approveMerge(job.id, requestId(), headSha), "Merged.")}
        />
      )}
      {has("close") && (
        <CloseButton job={job} kind={kind} disabled={disabled} loading={loading("close")} onClose={(reason) => void run("close", () => closeJob(job.id, requestId(), reason), "Closed.")} />
      )}
      {has("retry_stop") && (
        <Button size="sm" variant="outline" disabled={disabled} loading={loading("retry_stop")} onClick={() => void run("retry_stop", () => retryStop(job.id, requestId()), "Interrupting again.")}>
          <OctagonXIcon data-icon="inline-start" />
          Retry stop
        </Button>
      )}
      {has("dismiss") && (
        <Button size="sm" variant="ghost" disabled={disabled} loading={loading("dismiss")} onClick={() => void run("dismiss", () => dismissJob(job.id), "Dismissed from the inbox.")}>
          Dismiss
        </Button>
      )}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {has("answer") && (
        <Compose
          label="Your answer"
          description="Posted on the issue as your reply; the agent resumes with it."
          placeholder="Answer the question"
          submit="Send answer"
          icon={<SendIcon data-icon="inline-start" />}
          disabled={disabled}
          loading={loading("answer")}
          onSend={(text, clear) => void run("answer", () => answerQuestion(job.id, requestId(), text), "Answer sent.", clear)}
        />
      )}
      {has("request_changes") && (
        <Compose
          label="Request changes"
          description="Sent to the agent, which updates the same branch and PR."
          placeholder="What should change"
          submit="Request changes"
          icon={<MessageSquareReplyIcon data-icon="inline-start" />}
          disabled={disabled}
          loading={loading("request_changes")}
          onSend={(text, clear) => void run("request_changes", () => requestChanges(job.id, requestId(), text), "Sent to the agent.", clear)}
        />
      )}
      {has("follow_up") && (
        <Compose
          label="File a follow-up"
          description="Filed as a new issue with the failed checks, the merged PR and why the revert failed; the factory picks it up as a new job."
          placeholder="What the fix should do"
          initial={followUpHint(job, decision)}
          maxLength={MAX_FOLLOW_UP_CHARS}
          submit="File a follow-up"
          icon={<FilePlusIcon data-icon="inline-start" />}
          disabled={disabled}
          loading={loading("follow_up")}
          onSend={(text, clear) => void run("follow_up", () => fileFollowUp(job.id, requestId(), text), "Filed the follow-up.", clear)}
        />
      )}
      {buttons}
      <Waiting busy={busy} />
      {error && (
        <Alert variant="error">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
