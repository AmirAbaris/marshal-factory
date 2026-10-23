import type { Stage } from "@/lib/events";

export const STAGE_META: Record<Stage, { label: string; dot: string }> = {
  queued: { label: "Queued", dot: "bg-faint" },
  triage: { label: "Triage", dot: "bg-info" },
  investigating: { label: "Investigating", dot: "bg-violet" },
  implementing: { label: "Implementing", dot: "bg-primary" },
  verifying: { label: "Verifying", dot: "bg-warning" },
  pr: { label: "PR · CI", dot: "bg-primary" },
  waiting: { label: "Waiting on you", dot: "bg-warning" },
  merged: { label: "Merged", dot: "bg-success" },
  failed: { label: "Failed", dot: "bg-destructive" },
};

export const MAIN_PATH: readonly Stage[] = [
  "queued",
  "triage",
  "investigating",
  "implementing",
  "verifying",
  "pr",
  "merged",
];
