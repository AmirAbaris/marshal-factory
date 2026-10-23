import type { IssueRow, RunRow } from "@/db/schema";
import type { Stage } from "@/lib/events";
import { groupBy } from "./format";

/** One board card: a claimed issue, or a staged run whose issue the factory never claimed. */
export type BoardCard = {
  id: string;
  issueKey: string | null;
  title: string;
  stage: Stage;
  summary: string | null;
  question: string | null;
  prUrl: string | null;
  issueUrl: string | null;
  answeredAt: Date | null;
  /** The run the card opens; null while a claimed issue has no session yet. */
  latest: RunRow | null;
  runs: RunRow[];
};

const stagedAt = (run: RunRow) => run.stage_at?.getTime() ?? 0;

export function boardCards(issues: readonly IssueRow[], runs: readonly RunRow[]): BoardCard[] {
  const byKey = groupBy(
    runs.filter((r) => r.issue_key !== null),
    (r) => r.issue_key!,
  );
  const newestFirst = (rows: readonly RunRow[]) =>
    [...rows].sort((a, b) => stagedAt(b) - stagedAt(a));

  const fromIssues = issues.map((issue): BoardCard => {
    const issueRuns = newestFirst(byKey.get(issue.key) ?? []);
    return {
      id: issue.key,
      issueKey: issue.key,
      title: issue.title,
      stage: issue.stage,
      summary: issue.stage_summary,
      question: issue.question,
      prUrl: issue.pr_url,
      issueUrl: issue.url,
      answeredAt: issue.answered_at,
      latest: issueRuns.find((r) => r.session_id === issue.session_id) ?? issueRuns[0] ?? null,
      runs: issueRuns,
    };
  });

  const claimed = new Set(issues.map((i) => i.key));
  const unclaimed = runs.filter(
    (r): r is RunRow & { stage: Stage } =>
      r.stage !== null && !(r.issue_key && claimed.has(r.issue_key)),
  );
  const fromRuns = [...groupBy(unclaimed, (r) => r.issue_key ?? r.session_id).entries()].map(
    ([id, group]): BoardCard => {
      const sorted = newestFirst(group);
      const latest = sorted[0]! as RunRow & { stage: Stage };
      return {
        id,
        issueKey: latest.issue_key,
        title: latest.title ?? latest.issue_key ?? "Factory run",
        stage: latest.stage,
        summary: latest.stage_summary,
        question: latest.question,
        prUrl: sorted.find((r) => r.pr_url)?.pr_url ?? null,
        issueUrl: null,
        answeredAt: null,
        latest,
        runs: sorted,
      };
    },
  );
  return [...fromIssues, ...fromRuns];
}
