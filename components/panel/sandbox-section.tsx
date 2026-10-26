import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import type { AuditRow, JobRow } from "@/db/schema";
import { sandboxState } from "@/lib/execution";
import { SandboxBadge } from "./run-card";
import { Time } from "./time";

const shortSandboxId = (id: string) => (id.length > 14 ? `${id.slice(0, 12)}…` : id);

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/** Where a sandboxed job runs: no ids beyond the sandbox's, and no credentials. */
export function SandboxSection({ job, audit }: { job: JobRow; audit: readonly AuditRow[] }) {
  const state = sandboxState(job);
  if (!state) return null;
  const loginFailure = audit.find((row) => row.action === "sandbox_login_failed");
  return (
    <>
      <Separator />
      <section className="flex flex-col gap-2.5 px-4.5 py-3.5">
        <h3 className="text-sm font-medium text-muted-foreground">Sandbox</h3>
        <dl className="flex flex-col gap-1.5 text-sm">
          <Line label="State">
            <SandboxBadge state={state} />
          </Line>
          {job.sandbox_id && (
            <Line label="Sandbox">
              <span className="font-mono text-xs" title={job.sandbox_id}>
                {shortSandboxId(job.sandbox_id)}
              </span>
            </Line>
          )}
          <Line label="Codex login slot">{job.codex_slot ? "Held" : "Not held"}</Line>
          {loginFailure && (
            <Line label="Last login check">
              <span className="text-destructive">Failed</span>{" "}
              <span className="text-xs text-faint">
                <Time date={loginFailure.at} />
              </span>
            </Line>
          )}
        </dl>
        {state === "hibernated" && (
          <p className="text-xs text-muted-foreground">
            Snapshotted while the job waits. It wakes on its own when the job needs it again, such as an answer or a conflict to fix.
          </p>
        )}
      </section>
    </>
  );
}
