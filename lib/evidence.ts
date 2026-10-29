import { z } from "zod";
import { CHECKS, redact, type Recipe } from "./recipe";

// Proof tied to a commit: which checks ran at one exact revision, what each exited with, and
// whether the tree held that commit and nothing else. The agent's stage says what it reports; this
// says what was run. `hooks/verify.ts` (factory-verify) produces it wherever an agent works, and the
// runner produces it itself in a job's sandbox (runner/verify.ts). Ingest keeps the latest record
// per job and commit in job_evidence, and the merge decision reads the one for the PR's head.

export const EVIDENCE_CHECKS = [...CHECKS, "custom"] as const;
export type EvidenceCheckName = (typeof EVIDENCE_CHECKS)[number];
export const PRODUCERS = ["agent", "runner"] as const;
export type Producer = (typeof PRODUCERS)[number];
/** Where the checks came from: the repo's recipe, package.json scripts, or nowhere. */
export const CHECK_SOURCES = ["recipe", "package", "none"] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

export const OUTPUT_TAIL_LINES = 40;
export const OUTPUT_TAIL_CHARS = 4000;
/** The most output a check keeps in memory before the tail is cut. */
export const OUTPUT_KEEP_CHARS = 64_000;
export const MAX_EVIDENCE_CHECKS = 20;
export const CHECK_TIMEOUT_MS = 20 * 60_000;

export const SHA = /^[0-9a-f]{40}$/;
export const shortSha = (sha: string) => sha.slice(0, 7);

export const evidenceCheckSchema = z.object({
  name: z.enum(EVIDENCE_CHECKS),
  command: z.string().max(2000),
  /** Null when the command was killed, timed out or never started. */
  exitCode: z.number().int().nullable(),
  startedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  /** The end of the combined output, redacted and capped at OUTPUT_TAIL_CHARS. */
  outputTail: z.string().max(OUTPUT_TAIL_CHARS),
  passed: z.boolean(),
});
export type EvidenceCheck = z.infer<typeof evidenceCheckSchema>;

/** What an evidence event carries besides the event's own id, session and time. */
export const evidenceShape = {
  jobKey: z.string().min(1),
  attempt: z.number().int().positive(),
  /** owner/name. */
  repo: z.string().min(1).max(200),
  sha: z.string().regex(SHA),
  /** False when the tree had uncommitted changes or HEAD moved while the checks ran: then it proves nothing about sha. */
  clean: z.boolean(),
  producer: z.enum(PRODUCERS),
  source: z.enum(CHECK_SOURCES),
  checks: z.array(evidenceCheckSchema).max(MAX_EVIDENCE_CHECKS),
};
export const evidencePayloadSchema = z.object(evidenceShape);
export type EvidencePayload = z.infer<typeof evidencePayloadSchema>;

/** One check as a card and the inbox show it, without its output. */
const checkSummarySchema = evidenceCheckSchema.pick({ name: true, passed: true, exitCode: true, durationMs: true });

/** The job's latest evidence for its current attempt, kept on the job row for cards and the inbox. */
export const evidenceSummarySchema = z.object({
  sha: z.string(),
  attempt: z.number().int(),
  clean: z.boolean(),
  producer: z.enum(PRODUCERS),
  source: z.enum(CHECK_SOURCES),
  at: z.string(),
  checks: z.array(checkSummarySchema),
});
export type EvidenceSummary = z.infer<typeof evidenceSummarySchema>;

export const summarize = (e: Pick<EvidencePayload, "sha" | "attempt" | "clean" | "producer" | "source" | "checks">, at: Date): EvidenceSummary => ({
  sha: e.sha,
  attempt: e.attempt,
  clean: e.clean,
  producer: e.producer,
  source: e.source,
  at: at.toISOString(),
  checks: e.checks.map(({ name, passed, exitCode, durationMs }) => ({ name, passed, exitCode, durationMs })),
});

export const parseSummary = (value: unknown): EvidenceSummary | null => evidenceSummarySchema.safeParse(value).data ?? null;

// --- what to run

export type PlannedCheck = { name: EvidenceCheckName; command: string };
export type CheckPlan = {
  source: CheckSource;
  /** What a fresh checkout runs before the checks; the agent's own worktree has it done already. */
  setup: string[];
  checks: PlannedCheck[];
  /** Env var names whose values the output tails must not show. */
  envNames: string[];
};

const PACKAGE_MANAGERS = [
  { lock: ["bun.lock", "bun.lockb"], run: "bun run", install: "bun install --frozen-lockfile" },
  { lock: ["pnpm-lock.yaml"], run: "pnpm run", install: "pnpm install --frozen-lockfile" },
  { lock: ["yarn.lock"], run: "yarn run", install: "yarn install --frozen-lockfile" },
  { lock: ["package-lock.json"], run: "npm run", install: "npm ci" },
] as const;

/**
 * The checks a repo defines: its recipe's checks when it has a recipe, else the package.json
 * scripts named like the recipe's checks, run with the package manager its lockfile names.
 */
export function planChecks({ recipe, packageJson, files }: { recipe: Recipe | null; packageJson: string | null; files: readonly string[] }): CheckPlan {
  if (recipe) {
    return {
      source: "recipe",
      setup: recipe.setup,
      checks: CHECKS.flatMap((name) => {
        const command = recipe.checks[name];
        return command ? [{ name, command }] : [];
      }),
      envNames: (recipe.env ?? []).map((e) => e.name),
    };
  }
  let scripts: Record<string, unknown> = {};
  try {
    scripts = (packageJson ? (JSON.parse(packageJson) as { scripts?: Record<string, unknown> }).scripts : undefined) ?? {};
  } catch {
    scripts = {};
  }
  const names = CHECKS.filter((name) => typeof scripts[name] === "string");
  if (names.length === 0) return { source: "none", setup: [], checks: [], envNames: [] };
  const pm = PACKAGE_MANAGERS.find((m) => m.lock.some((lock) => files.includes(lock))) ?? PACKAGE_MANAGERS[3];
  return { source: "package", setup: [pm.install], checks: names.map((name) => ({ name, command: `${pm.run} ${name}` })), envNames: [] };
}

/** Names whose values never belong in an output tail, whatever the recipe lists. */
export const SECRET_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "FACTORY_INGEST_SECRET", "DATABASE_URL", "DATABASE_URL_UNPOOLED"];

/**
 * The end of a check's output worth keeping: credentials redacted by name and by shape
 * (lib/recipe.ts `redact`), any known secret value replaced wherever it appears, cut to
 * OUTPUT_TAIL_LINES lines and OUTPUT_TAIL_CHARS characters.
 */
export function outputTail(output: string, { envNames = [], secrets = [] }: { envNames?: readonly string[]; secrets?: readonly string[] } = {}) {
  let text = output.slice(-OUTPUT_KEEP_CHARS);
  for (const secret of secrets) if (secret.length >= 8) text = text.split(secret).join("[redacted]");
  return redact(text, [...envNames, ...SECRET_ENV], OUTPUT_TAIL_LINES).slice(-OUTPUT_TAIL_CHARS);
}

/**
 * Runs one command; exitCode null when it was killed or never started. Output is stdout and stderr
 * together. It throws only when the machine itself is unreachable, which is no result for the check.
 */
export type CheckRunner = (command: string, timeoutMs: number) => Promise<{ exitCode: number | null; output: string }>;

/** A command as bash runs it, with stderr into stdout so the tail reads in order. */
export const combined = (command: string) => `exec 2>&1\n${command}`;

/**
 * Runs the planned checks one after another, every one even after a failure, so the evidence says
 * which pass and which fail. A setup that fails is recorded as a failed custom check before them.
 */
export async function runChecks(
  plan: Pick<CheckPlan, "checks" | "envNames"> & { setup?: readonly string[] },
  run: CheckRunner,
  { secrets = [], timeoutMs = CHECK_TIMEOUT_MS, now = Date.now }: { secrets?: readonly string[]; timeoutMs?: number; now?: () => number } = {},
): Promise<EvidenceCheck[]> {
  const steps: PlannedCheck[] = [...(plan.setup?.length ? [{ name: "custom" as const, command: plan.setup.join(" && ") }] : []), ...plan.checks];
  const results: EvidenceCheck[] = [];
  for (const step of steps.slice(0, MAX_EVIDENCE_CHECKS)) {
    const started = now();
    const { exitCode, output } = await run(step.command, timeoutMs);
    results.push({
      name: step.name,
      command: step.command.slice(0, 2000),
      exitCode,
      startedAt: new Date(started).toISOString(),
      durationMs: Math.max(0, Math.round(now() - started)),
      outputTail: outputTail(output, { envNames: plan.envNames, secrets }),
      passed: exitCode === 0,
    });
  }
  return results;
}

// --- what the evidence proves about the PR's head

export const headEvidenceSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("no_checks") }),
  z.object({ state: z.literal("missing") }),
  /** The latest evidence is for another commit. */
  z.object({ state: z.literal("stale"), sha: z.string() }),
  z.object({ state: z.literal("dirty"), sha: z.string() }),
  /** Required checks the evidence at the head didn't run. */
  z.object({ state: z.literal("incomplete"), sha: z.string(), missing: z.array(z.string()) }),
  /** Checks that ran another command than the one the repo's recorded recipe names, so they prove nothing about it. */
  z.object({ state: z.literal("untrusted"), sha: z.string(), mismatched: z.array(z.string()) }),
  z.object({ state: z.literal("failed"), sha: z.string(), failed: z.array(z.string()), passed: z.number().int(), total: z.number().int() }),
  z.object({ state: z.literal("verified"), sha: z.string(), passed: z.number().int(), total: z.number().int(), producer: z.enum(PRODUCERS) }),
]);
export type HeadEvidence = z.infer<typeof headEvidenceSchema>;

export type EvidenceRow = { sha: string; clean: boolean; producer: Producer; source: CheckSource; checks: readonly Pick<EvidenceCheck, "name" | "passed" | "command">[]; recordedAt: Date };

/**
 * What the evidence for this attempt says about `headSha`. `required` is the repo's recorded recipe
 * checks, names and commands, when the factory knows its recipe; without one, the checks the
 * evidence itself found count. An agent plans its checks from its own worktree, so a check whose
 * command differs from the recorded one proves nothing.
 */
export function headEvidence(rows: readonly EvidenceRow[], headSha: string, required: readonly PlannedCheck[] | null): HeadEvidence {
  if (required?.length === 0) return { state: "no_checks" };
  const atHead = rows.find((r) => r.sha === headSha);
  if (!atHead) {
    const latest = [...rows].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())[0];
    return latest ? { state: "stale", sha: latest.sha } : { state: "missing" };
  }
  const named = atHead.checks.filter((c) => c.name !== "custom").map((c) => c.name);
  if (!required && named.length === 0) return { state: "no_checks" };
  if (!atHead.clean) return { state: "dirty", sha: headSha };
  const missing = (required ?? []).filter(({ name }) => !named.includes(name)).map(({ name }) => name);
  if (missing.length > 0) return { state: "incomplete", sha: headSha, missing };
  const mismatched = atHead.checks.filter((c) => required?.some((r) => r.name === c.name && r.command.trim() !== c.command.trim())).map((c) => c.name);
  if (mismatched.length > 0) return { state: "untrusted", sha: headSha, mismatched };
  const failed = atHead.checks.filter((c) => !c.passed).map((c) => (c.name === "custom" ? "setup" : c.name));
  const passed = atHead.checks.length - failed.length;
  if (failed.length > 0) return { state: "failed", sha: headSha, failed: [...new Set(failed)], passed, total: atHead.checks.length };
  return { state: "verified", sha: headSha, passed, total: atHead.checks.length, producer: atHead.producer };
}

/** Evidence that leaves the head unproven, but that a fresh run of the checks could settle. */
export const unproven = (e: HeadEvidence): e is Extract<HeadEvidence, { state: "missing" | "stale" | "dirty" | "incomplete" | "untrusted" }> =>
  e.state === "missing" || e.state === "stale" || e.state === "dirty" || e.state === "incomplete" || e.state === "untrusted";

/** Why an unproven head is unproven, as a clause. */
export function notVerifiedWhy(e: Extract<HeadEvidence, { state: "missing" | "stale" | "dirty" | "incomplete" | "untrusted" }>) {
  switch (e.state) {
    case "missing":
      return "no checks were reported for it";
    case "stale":
      return `the latest checks ran at ${shortSha(e.sha)}`;
    case "dirty":
      return "the checks ran with uncommitted changes";
    case "incomplete":
      return `the checks didn't include ${e.missing.join(", ")}`;
    case "untrusted":
      return `the checks ran other commands than the recipe records for ${e.mismatched.join(", ")}`;
    default: {
      const never: never = e;
      throw new Error(`unknown evidence state ${String(never)}`);
    }
  }
}

export type EvidenceLine = { text: string; tone: "success" | "destructive" | "warning" | "muted" };

/**
 * The line a card shows apart from its stage: the latest evidence, held against the PR head when
 * the runner knows it. Null when nothing was verified and nothing is waiting on it.
 */
export function evidenceLine(summary: EvidenceSummary | null, headSha: string | null, { expected }: { expected: boolean }): EvidenceLine | null {
  if (!summary) return expected ? { text: "Not verified at head", tone: "warning" } : null;
  if (headSha && summary.sha !== headSha) return { text: "Not verified at head", tone: "warning" };
  const passed = summary.checks.filter((c) => c.passed).length;
  const count = `${passed}/${summary.checks.length} check${summary.checks.length === 1 ? "" : "s"}`;
  const at = shortSha(summary.sha);
  if (summary.checks.length === 0) return { text: `No checks defined · ${at}`, tone: "warning" };
  if (!summary.clean) return { text: `Not verified at ${at} · uncommitted changes`, tone: "warning" };
  if (passed < summary.checks.length) return { text: `Checks failed at ${at} · ${count}`, tone: "destructive" };
  return { text: `Verified at ${at} · ${count}`, tone: "success" };
}

export const CHECK_NAME_LABELS: Record<EvidenceCheckName, string> = { test: "Tests", lint: "Lint", typecheck: "Typecheck", build: "Build", custom: "Setup" };

export const PRODUCER_LABELS: Record<Producer, string> = { agent: "the agent", runner: "the factory" };

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
