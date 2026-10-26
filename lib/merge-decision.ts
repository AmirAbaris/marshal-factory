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
});
export type MergeDecision = z.infer<typeof mergeDecisionSchema>;

export type CheckState = "success" | "pending" | "failure";
export type BugbotFinding = { severity: "high" | "medium" | "low"; resolved: boolean };
export type ChangedFile = { path: string; previousPath?: string; additions: number; deletions: number; patch?: string };

/** What GitHub says about the PR head. */
export type PrFacts = {
  headSha: string;
  mergeable: "mergeable" | "conflicting" | "unknown";
  behindBy: number;
  /** Every check run and commit status on the head, Bugbot's aside; pending also when none reported yet. */
  checks: CheckState;
  bugbot: { finished: boolean; findings: readonly BugbotFinding[] };
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
  if (!pr.bugbot.finished) waiting.push("Bugbot");
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
  return { outcome: "merge", reasons: input.policy.autonomy === "auto" ? ["Auto-merge isn't switched on yet, so this runs as a trial."] : [] };
}
