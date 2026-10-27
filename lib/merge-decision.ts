import { z } from "zod";
import { ASSESSMENT_CHECKS, CHECK_LABELS, type MergeAssessment } from "./assessment";

// Whether a factory PR would merge on its own. The agent recommends (lib/assessment.ts); the
// runner enforces hard limits that no recommendation overrides. Pure, so the runner pass and the
// regressions share it.

export const AUTONOMY_LEVELS = ["off", "trial", "auto"] as const;
export const autonomySchema = z.enum(AUTONOMY_LEVELS);
export type Autonomy = z.infer<typeof autonomySchema>;

export const AUTONOMY_LABELS: Record<Autonomy, string> = { off: "Off", trial: "Trial", auto: "Merge when confident" };

export const DEFAULT_PROTECTED_PATHS = [
  "drizzle/**",
  "**/migrations/**",
  "**/auth/**",
  "**/permissions/**",
  "**/billing/**",
  "**/payments/**",
  ".github/**",
  "vercel.json",
  "vercel.ts",
  "**/.env*",
];
export const DEFAULT_MAX_CHANGED_LINES = 300;
export const CHECKS_TIMEOUT_MS = 60 * 60_000;
export const REVIEW_LABEL = "review";

export type RepoPolicy = { autonomy: Autonomy; protectedPaths: readonly string[]; maxChangedLines: number };
export const DEFAULT_POLICY: RepoPolicy = { autonomy: "off", protectedPaths: DEFAULT_PROTECTED_PATHS, maxChangedLines: DEFAULT_MAX_CHANGED_LINES };

export const MERGE_OUTCOMES = ["merge", "handover", "pending"] as const;
export type MergeOutcome = (typeof MERGE_OUTCOMES)[number];

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** Where a factory merge started: the timer's own decision, or the owner's approval in the inbox or in run detail. */
export const MERGE_VIAS = ["auto", "inbox", "run_detail"] as const;
export type MergeVia = (typeof MERGE_VIAS)[number];

export const WATCH_STATES = ["watching", "green", "expired", "reverted", "revert_failed"] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/** What the factory merged; the post-merge watch reads the base branch at this commit. */
export const factoryMergeSchema = z.object({
  sha: z.string(),
  method: z.enum(MERGE_METHODS),
  at: z.string(),
  base: z.string(),
  title: z.string(),
  /** The PR's commit count; a rebase merge put that many commits on the base. */
  commits: z.number().int().positive(),
  /** Absent on merges recorded before the entry point was kept. */
  via: z.enum(MERGE_VIAS).optional(),
});
export type FactoryMerge = z.infer<typeof factoryMergeSchema>;

export const watchSchema = z.object({
  state: z.enum(WATCH_STATES),
  until: z.string(),
  /** The checks that failed on the base branch. */
  failed: z.array(z.string()),
  revertPr: z.string().nullable(),
  /** Why the revert failed. */
  reason: z.string().nullable(),
});
export type MergeWatch = z.infer<typeof watchSchema>;

/** The most changed files a review summary lists; fileCount still counts them all. */
export const REVIEW_FILE_LIMIT = 100;

/** What the owner reviews in the inbox: the PR's changed files and Bugbot's findings at one head. */
export const reviewSchema = z.object({
  headSha: z.string(),
  files: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number() })),
  fileCount: z.number().int(),
  bugbot: z.object({
    state: z.enum(["pending", "reviewed", "failed"]),
    /** Unresolved findings by severity. */
    high: z.number().int(),
    medium: z.number().int(),
    low: z.number().int(),
    resolved: z.number().int(),
  }),
});
export type ReviewSummary = z.infer<typeof reviewSchema>;

export const mergeDecisionSchema = z.object({
  outcome: z.enum(MERGE_OUTCOMES),
  reasons: z.array(z.string()),
  autonomy: autonomySchema,
  evaluatedAt: z.string(),
  /** The PR head the decision is about; null when autonomy is off and GitHub was not asked. */
  headSha: z.string().nullable(),
  /** When this head was first seen, so the checks timeout runs from the push, not the latest pass. */
  headSeenAt: z.string().nullable(),
  /** The stage event the decision read the assessment from. */
  stageEventId: z.string().nullable(),
  /** Why GitHub refused the factory's merge of this head; it is not tried again until the head moves. */
  blocked: z.string().optional(),
  /** Written right before the factory asks GitHub to merge, so a crash after the merge is recorded on a later pass. */
  merging: z.object({ headSha: z.string(), method: z.enum(MERGE_METHODS), at: z.string(), via: z.enum(MERGE_VIAS).optional() }).optional(),
  merged: factoryMergeSchema.optional(),
  watch: watchSchema.optional(),
  /** Fingerprints of the decision comments last posted on the PR and in the source. */
  comments: z.object({ pr: z.string().optional(), source: z.string().optional() }).optional(),
  /** The facts the decision read, for the inbox; absent when autonomy is off, which reads none. */
  review: reviewSchema.optional(),
  /** Set when the owner approved this head in the inbox or run detail; the merge then skips the agent's and the policy's reasons. */
  approvedBy: z.string().optional(),
});
export type MergeDecision = z.infer<typeof mergeDecisionSchema>;

export type CheckState = "success" | "pending" | "failure";
export type BugbotFinding = { severity: "high" | "medium" | "low"; resolved: boolean };
/** Bugbot's run on the head: still running (or not started), reviewed, or ended without a review. */
export type BugbotReview = { state: "pending" } | { state: "reviewed" } | { state: "failed"; conclusion: string };
export type ChangedFile = { path: string; previousPath?: string; additions: number; deletions: number; patch?: string };

/** What GitHub says about the PR head. */
export type PrFacts = {
  headSha: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  behindBy: number;
  /** Every check run and commit status on the head, Bugbot's aside; pending also when none reported yet. */
  checks: CheckState;
  bugbot: { review: BugbotReview; findings: readonly BugbotFinding[] };
  files: readonly ChangedFile[];
};

export type DecisionInput = {
  policy: RepoPolicy;
  tracked: boolean;
  assessment: MergeAssessment | null;
  attempt: number;
  spendUsd: number;
  budgetUsd: number;
  labels: readonly string[];
  /** Null only when autonomy is off, which never asks GitHub. */
  pr: PrFacts | null;
  headSeenAt: number;
  now: number;
  checksTimeoutMs?: number;
};

export type Decision = { outcome: MergeOutcome; reasons: string[] };

const escape = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** `**` spans directories, `*` and `?` stay inside one; a leading `**\/` also matches the root. */
export function globToRegExp(glob: string) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        source += "(?:.*/)?";
        i += 2;
      } else {
        source += ".*";
        i += 1;
      }
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += escape(c);
  }
  return new RegExp(`^${source}$`);
}

export const matchesAny = (path: string, globs: readonly string[]) => globs.some((glob) => globToRegExp(glob).test(path));

const MANIFEST = /(^|\/)package\.json$/;
const DEPENDENCY_LINE = /^([+-])\s*"([^"]+)"\s*:\s*"[~^>=<v\s]*(\d+)[^"]*"\s*,?\s*$/;

/** Dependencies whose major version a manifest diff raises or lowers. */
export function majorBumps(files: readonly ChangedFile[]): string[] {
  const bumped = new Set<string>();
  for (const file of files) {
    if (!MANIFEST.test(file.path) || !file.patch) continue;
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (const line of file.patch.split("\n")) {
      const match = DEPENDENCY_LINE.exec(line);
      if (match) (match[1] === "-" ? before : after).set(match[2]!, Number(match[3]));
    }
    for (const [name, major] of after) {
      const was = before.get(name);
      if (was !== undefined && was !== major) bumped.add(name);
    }
  }
  return [...bumped].sort();
}

const minutes = (ms: number) => Math.round(ms / 60_000);

/** Hard limits only; each failure is one plain reason. */
function hardLimits(input: DecisionInput, pr: PrFacts) {
  const reasons: string[] = [];
  if (input.labels.some((l) => l.toLowerCase() === REVIEW_LABEL)) reasons.push(`The issue has the "${REVIEW_LABEL}" label.`);
  if (input.attempt !== 1) reasons.push(`This is attempt ${input.attempt}; only a first attempt merges on its own.`);
  if (input.spendUsd >= input.budgetUsd) reasons.push("The run went over its budget.");
  if (pr.checks === "failure") reasons.push("A check failed on the latest commit.");
  if (pr.mergeable === "conflicting") reasons.push("The pull request conflicts with its base branch.");
  if (pr.behindBy > 0) reasons.push(`The branch is ${pr.behindBy} commit${pr.behindBy === 1 ? "" : "s"} behind its base.`);
  if (pr.bugbot.review.state === "failed") reasons.push(`Bugbot didn't complete its review (${pr.bugbot.review.conclusion}).`);
  const open = pr.bugbot.findings.filter((f) => !f.resolved && f.severity !== "low");
  if (open.length > 0) reasons.push(`Bugbot has ${open.length} unresolved medium or high finding${open.length === 1 ? "" : "s"}.`);
  const touched = pr.files.flatMap((f) => [f.path, ...(f.previousPath ? [f.previousPath] : [])]);
  const protectedHits = [...new Set(touched.filter((p) => matchesAny(p, input.policy.protectedPaths)))];
  if (protectedHits.length > 0) reasons.push(`It touches protected paths: ${protectedHits.slice(0, 5).join(", ")}${protectedHits.length > 5 ? ", …" : ""}.`);
  const bumps = majorBumps(pr.files);
  if (bumps.length > 0) reasons.push(`It changes the major version of ${bumps.join(", ")}.`);
  const lines = pr.files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  if (lines > input.policy.maxChangedLines) reasons.push(`It changes ${lines} lines, over the limit of ${input.policy.maxChangedLines}.`);
  return reasons;
}

function agentReasons({ tracked, assessment }: DecisionInput) {
  if (!tracked) return ["This harness doesn't report a merge assessment."];
  if (!assessment) return ["The agent didn't report a merge assessment."];
  if (assessment.recommendation === "merge") return [];
  const failed = ASSESSMENT_CHECKS.filter((name) => !assessment.checks[name].ok).map((name) => `${CHECK_LABELS[name]}: ${assessment.checks[name].note}`);
  return failed.length > 0 ? failed : ["The agent recommends handing over."];
}

function waitingOn(pr: PrFacts) {
  const waiting: string[] = [];
  if (pr.checks === "pending") waiting.push("checks");
  if (pr.bugbot.review.state === "pending") waiting.push("Bugbot");
  if (pr.mergeable === "unknown") waiting.push("GitHub's mergeability check");
  return waiting;
}

/** Off evaluates nothing: the PR is ready for review, with no reasons to give. */
export const OFF_DECISION: Decision = { outcome: "handover", reasons: [] };

export function decideMerge(input: DecisionInput): Decision {
  if (input.policy.autonomy === "off") return OFF_DECISION;
  if (!input.pr) throw new Error("decideMerge needs the PR's facts unless autonomy is off");
  const reasons = [...agentReasons(input), ...hardLimits(input, input.pr)];
  if (reasons.length > 0) return { outcome: "handover", reasons };
  const waiting = waitingOn(input.pr);
  if (waiting.length > 0) {
    const timeout = input.checksTimeoutMs ?? CHECKS_TIMEOUT_MS;
    if (input.now - input.headSeenAt < timeout) return { outcome: "pending", reasons: [`Waiting for ${waiting.join(", ")}.`] };
    return { outcome: "handover", reasons: [`${waiting.join(", ")} didn't finish within ${minutes(timeout)} minutes.`.replace(/^./, (c) => c.toUpperCase())] };
  }
  return { outcome: "merge", reasons: [] };
}

export function reviewSummary(pr: Pick<PrFacts, "headSha" | "files" | "bugbot">): ReviewSummary {
  const open = pr.bugbot.findings.filter((f) => !f.resolved);
  const count = (severity: BugbotFinding["severity"]) => open.filter((f) => f.severity === severity).length;
  return {
    headSha: pr.headSha,
    files: pr.files.slice(0, REVIEW_FILE_LIMIT).map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    fileCount: pr.files.length,
    bugbot: { state: pr.bugbot.review.state, high: count("high"), medium: count("medium"), low: count("low"), resolved: pr.bugbot.findings.length - open.length },
  };
}

/**
 * What still stops a merge the owner approved. Only facts about the PR count: the agent's
 * reasons, the policy's limits and Bugbot's findings are the owner's to overrule.
 */
export function approvalBlockers(pr: Pick<PrFacts, "checks" | "mergeable" | "behindBy">): string[] {
  const reasons: string[] = [];
  if (pr.checks === "failure") reasons.push("A check failed on the latest commit.");
  if (pr.checks === "pending") reasons.push("Checks are still running on the latest commit.");
  if (pr.mergeable === "conflicting") reasons.push("The pull request conflicts with its base branch.");
  if (pr.mergeable === "unknown") reasons.push("GitHub is still checking whether the pull request merges cleanly.");
  if (pr.behindBy > 0) reasons.push(`The branch is ${pr.behindBy} commit${pr.behindBy === 1 ? "" : "s"} behind its base.`);
  return reasons;
}

/** The reason a decision hands over when GitHub refuses the factory's merge. */
export const blockedReason = (detail: string) => `The factory's GitHub App can't merge in this repo: ${detail}`;
