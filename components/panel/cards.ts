import type { RunRow } from "@/db/schema";
import type { Stage } from "@/lib/events";
import { groupBy } from "./format";

/** One board card: an issue, or a staged run without an issue key. */
export type BoardCard = {
  id: string;
  issueKey: string | null;
  title: string;
  stage: Stage;
  summary: string | null;
  question: string | null;
  prUrl: string | null;
  /** The run whose stage the card shows; the link target. */
  latest: RunRow;
  runs: RunRow[];
};

const stagedAt = (run: RunRow) => run.stage_at?.getTime() ?? 0;

export function stagedCards(runs: readonly RunRow[]): BoardCard[] {
  const staged = runs.filter((r): r is RunRow & { stage: Stage } => r.stage !== null);
  return [...groupBy(staged, (r) => r.issue_key ?? r.session_id).entries()].map(
    ([id, group]) => {
      const sorted = [...group].sort((a, b) => stagedAt(b) - stagedAt(a));
      const latest = sorted[0]!;
      return {
        id,
        issueKey: latest.issue_key,
        title: latest.title ?? latest.issue_key ?? "Factory run",
        stage: latest.stage,
        summary: latest.stage_summary,
        question: latest.question,
        prUrl: sorted.find((r) => r.pr_url)?.pr_url ?? null,
        latest,
        runs: sorted,
      };
    },
  );
}
