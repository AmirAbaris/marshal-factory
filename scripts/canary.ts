import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";

// Files one fixed UI ticket on a test repo and follows the job to its pull request, to prove a
// rollout end to end: the job launches in a Modal sandbox, the agent opens a page on localhost with
// the `playwright` browser, attaches a screenshot to its assessment, verifies its head with
// factory-verify and opens a PR. The issue carries the `review` label, which the merge decision
// always hands over on, so the canary's PR never merges, even on a repo set to auto.
//   bun scripts/canary.ts [--repo owner/name] [--timeout-minutes 60] [--checkout <path>]
// It exits 0 when every check passed and 1 otherwise. The PR and the issue stay open for you to
// look at; close both when done.

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const checkout = resolve(option("--checkout") ?? join(import.meta.dirname, ".."));
const repo = option("--repo") ?? "ski043/factory-playground";
const timeoutMs = Number(option("--timeout-minutes") ?? 60) * 60_000;

// The checkout only lends its env; the code is this script's own, so --checkout from a newer branch files with that branch's filer.
process.chdir(checkout);
process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { jobEvidence, jobs, jobScreenshots } = await import("../db/schema");
const { loadConfig } = await import("../lib/config");
const { parseJob, sourceFor } = await import("../lib/sources");
const { linearFiler } = await import("../lib/sources/linear");
const { readRegistry, repoLabel, REPOSITORY_GROUP } = await import("../lib/repositories");
const { RUNS_ON_GROUP, RUNS_ON_LABELS } = await import("../lib/ticket-overrides");
const { REVIEW_LABEL } = await import("../lib/merge-decision");
type JobRow = typeof jobs.$inferSelect;

const t0 = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - t0) / 60_000).toFixed(1)}m] ${message}`);
const finish = async (passed: boolean, message: string) => {
  console.log(`\ncanary ${passed ? "PASSED" : "FAILED"}: ${message}`);
  process.exit(passed ? 0 : 1);
};

const PORT = 4173;
const description = `Factory canary, filed by scripts/canary.ts to check a rollout. Its pull request is for the owner to read and close, never to merge.

Add \`demo/index.html\`: one static page titled "Unit converter demo" with a heading and a table of five conversions this library does (for example 10 km in miles), the numbers written into the HTML by hand. No build step, no script tag, no new dependency, and nothing else in the repo changes.

Then, in this order:
1. Serve the page on localhost with a static server that is already installed, for example \`python3 -m http.server ${PORT} --directory demo\`.
2. Open http://localhost:${PORT}/ with the \`playwright\` browser and take a viewport screenshot of the page.
3. Run \`factory-verify\` at your final commit.
4. Open the pull request and report \`pr\` with the screenshot attached to your assessment.`;

const config = loadConfig();
const registry = await readRegistry(db);
const target = registry.find((r) => r.repo === repo);
if (!target?.enabled) await finish(false, `${repo} is not an enabled repository`);

const filed = await linearFiler(config.linearApiKey, config.factory.teamKey, config.factory.label)({
  requestId: randomUUID(),
  title: `Canary ${new Date().toISOString().slice(0, 16).replace("T", " ")}: unit converter demo page`,
  description,
  labels: [
    { group: REPOSITORY_GROUP, name: repoLabel(registry, target!) },
    { group: RUNS_ON_GROUP, name: RUNS_ON_LABELS.modal },
  ],
  tags: [REVIEW_LABEL],
});
log(`filed ${filed.key} for ${repo}: ${filed.url}`);

type Check = { name: string; ok: boolean; detail: string };

/** What the job has proven so far; every check must hold once it reached its PR. */
async function checks(job: JobRow): Promise<Check[]> {
  const shots = job.stage_event_id ? await db.select({ file: jobScreenshots.file }).from(jobScreenshots).where(eq(jobScreenshots.stage_event_id, job.stage_event_id)) : [];
  const head = job.pr_url ? prHead(job.pr_url) : null;
  const [evidence] = head ? await db.select().from(jobEvidence).where(and(eq(jobEvidence.job_key, job.key), eq(jobEvidence.sha, head.sha))) : [];
  const failedChecks = evidence?.checks.filter((c) => c.exitCode !== 0).map((c) => c.name) ?? [];
  const decision = job.merge_decision;
  return [
    { name: "launched in a sandbox", ok: job.execution === "modal" && Boolean(job.sandbox_id ?? job.sandbox_snapshot), detail: `execution ${job.execution ?? "none"}` },
    { name: "opened a PR", ok: head?.state === "OPEN", detail: job.pr_url ? `${job.pr_url} is ${head?.state ?? "unreadable"}` : "no PR yet" },
    { name: "screenshot from the browser attached", ok: shots.length > 0, detail: shots.length > 0 ? shots.map((s) => s.file).join(", ") : "none on the pr report" },
    {
      name: "factory-verify passed at the head",
      ok: Boolean(evidence?.clean && evidence.producer === "agent" && evidence.checks.length > 0 && failedChecks.length === 0),
      detail: evidence ? `${evidence.producer}, ${evidence.clean ? "clean" : "dirty"}, ${evidence.checks.map((c) => `${c.name} ${c.exitCode}`).join(", ")}` : `no evidence for ${head?.sha.slice(0, 7) ?? "the head"}`,
    },
    {
      name: "handed over, not merged",
      ok: decision?.outcome === "handover" && !decision.merged,
      detail: decision ? `${decision.outcome}: ${decision.reasons.join(" ")}` : "no decision yet",
    },
  ];
}

function prHead(url: string) {
  try {
    const pr = JSON.parse(execFileSync("gh", ["pr", "view", url, "--json", "headRefOid,state"], { encoding: "utf8" })) as { headRefOid: string; state: string };
    return { sha: pr.headRefOid, state: pr.state };
  } catch {
    return null;
  }
}

let seen = "";
let missing = "";
let labelChecked = false;
for (const deadline = Date.now() + timeoutMs; ; await new Promise((r) => setTimeout(r, 30_000))) {
  const [job] = await db.select().from(jobs).where(eq(jobs.key, filed.key));
  const now = job ? `${job.stage}${job.stage_summary ? `: ${job.stage_summary}` : ""}` : "not claimed yet";
  if (now !== seen) log(now);
  seen = now;
  // The review label is all that keeps the PR from merging on an auto repo, so it is read back once the job exists, long before any decision.
  if (job && !labelChecked) {
    const labels = (await sourceFor(job.source).labels(parseJob(job))).map((l) => l.toLowerCase());
    if (!labels.includes(REVIEW_LABEL)) await finish(false, `${filed.key} has no ${REVIEW_LABEL} label (${labels.join(", ")}); add it in Linear or stop the job before its PR`);
    labelChecked = true;
  }
  if (job?.stage === "merged") await finish(false, `${filed.key} merged, which the review label should have prevented; revert ${job.pr_url}`);
  if (job?.stage === "failed") await finish(false, `${filed.key} failed: ${job.stage_summary ?? job.previous_failure ?? "no reason recorded"}`);
  if (job?.stage === "waiting") await finish(false, `${filed.key} asked a question instead of finishing: ${job.question ?? ""}`);
  if (job?.stage === "pr") {
    const results = await checks(job);
    const open = results.filter((c) => !c.ok);
    if (open.length === 0) {
      for (const c of results) console.log(`  ok  ${c.name}: ${c.detail}`);
      await finish(true, `${filed.key} ${job.pr_url}; close the PR and the issue when you have looked`);
    }
    const now = open.map((c) => `${c.name} (${c.detail})`).join("; ");
    if (now !== missing) log(`still waiting on: ${now}`);
    missing = now;
    if (Date.now() > deadline) {
      for (const c of results) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
      await finish(false, `${filed.key} reached its PR without all checks after ${timeoutMs / 60_000} minutes`);
    }
  } else if (Date.now() > deadline) await finish(false, `${filed.key} is still ${job?.stage ?? "unclaimed"} after ${timeoutMs / 60_000} minutes`);
}
