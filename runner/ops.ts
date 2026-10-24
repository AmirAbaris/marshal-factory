import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, issues, runs, type IssueRow } from "../db/schema";
import type { Stage, Usage } from "../lib/events";
import { loadConfig } from "../lib/config";
import { sourceFor } from "../lib/sources";
import type { JobSource, SourceAdapter } from "../lib/sources/types";
import { branchSpend } from "../lib/spend";
import { readTranscript, subagentTranscripts, sumUsage, transcriptPathFor } from "../lib/transcript";
import { cleanupRepo, cleanupSubagentWorktrees } from "../lib/worktrees";
import { claimConflict, conflictMessage, unclaimedRunsWithPr } from "../lib/conflicts";
import { attemptBranch } from "../lib/factory";
import { nudgeMessage, watch, type ThreadState } from "../lib/watchdog";
import { forbidInTest } from "../lib/test-mode";
import { runWithInput } from "../lib/exec";
import { bindingOf, canReclaimSql, PENDING, stopDeliverableSql } from "./binding";
import { claimReplies, qaBlock, resumeMessage } from "../lib/resume";


// The factory's deterministic work. The runner calls these from webhook intents, its timer and
// its startup reconcile; every one of them is idempotent, so calling one twice changes nothing.

export const config = loadConfig();

/** Stages where a thread is working; waiting, pr, merged and failed free the slot. */
export const IN_FLIGHT: Stage[] = ["queued", "triage", "investigating", "implementing", "verifying"];

const run = promisify(execFile);
// The LaunchAgent sets T3CODE_CLI_PATH; otherwise t3 must be on PATH.
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";

const prSchema = z.object({ state: z.string(), mergeable: z.string(), headRefOid: z.string() });

async function prState(url: string) {
  forbidInTest("gh");
  const { stdout } = await run("gh", ["pr", "view", url, "--json", "state,mergeable,headRefOid"], {
    timeout: 20_000,
  });
  return prSchema.parse(JSON.parse(stdout));
}

/**
 * Follows every factory PR: a merged one moves its issue to merged, and one that conflicts with
 * main while its issue sits in pr sends the thread back to merge main. The conflict is handled
 * once per PR head, so a pass never repeats the request while the thread works on it.
 */
export async function checkPullRequests() {
  const open = await db
    .select()
    .from(issues)
    .where(and(isNotNull(issues.pr_url), ne(issues.stage, "merged")));
  const conflicts: string[] = [];
  for (const issue of open) {
    const pr = await prState(issue.pr_url!);
    if (pr.state === "OPEN" && pr.mergeable === "CONFLICTING" && issue.stage === "pr") {
      if (await sendBackForConflict(issue, pr.headRefOid)) conflicts.push(issue.key);
      continue;
    }
    if (pr.state !== "MERGED") continue;
    await postMerged(issue.key, issue.pr_url!, issue.session_id ?? `merged:${issue.linear_id}`);
  }

  for (const run of await unclaimedRunsWithPr(db)) {
    if ((await prState(run.pr_url!)).state === "MERGED") await postMerged(run.issue_key!, run.pr_url!, run.session_id);
  }
  return conflicts;
}

/** A merge goes in as a stage event, so the run, the issue, the timeline and the write-back all follow it. */
async function postMerged(issueKey: string, prUrl: string, sessionId: string) {
  await postEvent({
    eventId: `merged:${prUrl}:${sessionId}`,
    sessionId,
    at: Date.now(),
    kind: "stage",
    stage: "merged",
    summary: `Merged ${prUrl}`,
    prUrl,
    issueKey,
  });
}

async function sendBackForConflict(issue: IssueRow, head: string) {
  // Ask T3 first: a CLI error then aborts the pass before anything is claimed.
  const thread = await threads.state(issue.t3_thread_id);
  if (!(await claimConflict(db, issue.linear_id, head))) return false;
  const release = () =>
    db.update(issues).set({ conflict_head: issue.conflict_head }).where(eq(issues.linear_id, issue.linear_id));

  const now = Date.now();
  try {
    if (thread === "gone") {
      await postEvent({
        eventId: `conflict:${issue.linear_id}:${head}`,
        sessionId: issue.session_id ?? `conflict:${issue.linear_id}`,
        at: now,
        kind: "stage",
        stage: "failed",
        summary: `${issue.pr_url} conflicts with main and its T3 thread is gone.`,
        issueKey: issue.key,
      });
      return true;
    }
    await threads.send(issue.t3_thread_id!, conflictMessage(issue.key, issue.pr_url!));
  } catch (error) {
    await release();
    throw error;
  }
  // The thread has the message now; if this event fails, its own reports still move the board.
  await postEvent({
    eventId: `conflict:${issue.linear_id}:${head}`,
    sessionId: issue.session_id ?? `conflict:${issue.linear_id}`,
    at: now,
    kind: "stage",
    stage: "implementing",
    summary: `${issue.pr_url} conflicts with main; the thread is merging main into the branch.`,
    issueKey: issue.key,
  });
  return true;
}

async function postEvent(event: Record<string, unknown>) {
  forbidInTest("the deployed ingest function");
  const res = await fetch(config.ingestUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ingest answered ${res.status}: ${await res.text()}`);
}

/** Gone means T3 no longer has the thread, it is archived, or its worktree left the disk. */
async function showThread(threadId: string | null): Promise<ThreadState> {
  forbidInTest("t3 thread show");
  if (!threadId) return "gone";
  // A launch in progress; the runner records the real id or clears the marker.
  if (bindingOf(threadId) === "pending") return "running";
  let stdout: string;
  try {
    ({ stdout } = await run(T3, ["thread", "show", threadId, "--json"], { timeout: 20_000 }));
  } catch (error) {
    // Only T3 saying the thread is gone counts as gone; a timeout or crash must not start a second thread.
    const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
    if (output.includes("no longer available")) return "gone";
    throw error;
  }
  const { thread } = z
    .object({
      thread: z.object({
        archived: z.boolean(),
        worktreePath: z.string().nullable(),
        activeRunId: z.string().nullable(),
      }),
    })
    .parse(JSON.parse(stdout));
  if (thread.archived || (thread.worktreePath !== null && !existsSync(thread.worktreePath))) return "gone";
  return thread.activeRunId ? "running" : "stopped";
}

export const threads = {
  state: showThread,
  async send(threadId: string, message: string) {
    forbidInTest("t3 thread send");
    await runWithInput(T3, ["thread", "send", threadId, "-"], message, 30_000);
  },
};

const threadAlive = async (threadId: string | null) => (await threads.state(threadId)) !== "gone";

/**
 * Hands answers to waiting questions back to the run that asked. The reply ids are claimed in
 * the database before anything is sent, so a replayed or concurrent pass never delivers twice.
 */
export async function resumeAnswered() {
  const waiting = await db.select().from(issues).where(eq(issues.stage, "waiting"));
  const resumed: string[] = [];
  for (const issue of waiting) {
    const plan = await sourceFor("linear").replies(issue);
    if (plan.kind === "wait") continue;

    const now = new Date();
    if (plan.kind === "close") {
      const closed = `closed:${plan.state}`;
      await db
        .update(issues)
        .set({
          stage: "failed",
          stage_at: now,
          stage_summary: `Moved to ${plan.state} in Linear while waiting; not resumed.`,
          question: null,
          resume_context: null,
          stage_event_id: closed,
          synced_event_id: closed,
          linear_state: plan.state,
          updated_at: now,
        })
        .where(and(eq(issues.linear_id, issue.linear_id), eq(issues.stage, "waiting")));
      resumed.push(`${issue.key}:closed`);
      continue;
    }

    const replyIds = plan.replies.map((r) => r.id);
    const alive = await threadAlive(issue.t3_thread_id);
    // A dead thread is unlinked in the same update that claims the replies, so the relaunch
    // cannot be lost to a later failure in this pass.
    const relaunch = alive ? undefined : qaBlock(plan.question, plan.answer);
    if (!(await claimReplies(db, issue.linear_id, replyIds, plan.answer, now, relaunch))) continue;

    if (alive) {
      try {
        await threads.send(issue.t3_thread_id!, resumeMessage(sourceFor("linear").describe(issue), plan.question, plan.answer));
      } catch (error) {
        await db
          .update(issues)
          .set({ delivered_reply_ids: issue.delivered_reply_ids, answered_at: issue.answered_at, answer: issue.answer })
          .where(eq(issues.linear_id, issue.linear_id));
        throw error;
      }
    }

    const summary = alive
      ? "Answer received; the thread resumes from triage."
      : "Answer received; a fresh thread will pick it up.";
    await postEvent({
      eventId: `resume:${issue.linear_id}:${replyIds.join(",")}`,
      sessionId: issue.session_id ?? `resume:${issue.linear_id}`,
      at: now.getTime(),
      kind: "stage",
      stage: "queued",
      summary,
      answer: plan.answer.slice(0, 4000),
      issueKey: issue.key,
    });
    await sourceFor("linear").acknowledgeReplies(issue, replyIds);
    resumed.push(`${issue.key}:${alive ? "sent" : "relaunch"}`);
  }
  return resumed;
}

/** Nudges stuck runs once, then fails them; see lib/watchdog.ts for when a run counts as stuck. */
export async function watchdog() {
  const working = await db
    .select({
      issue: issues,
      // Only the current attempt's runs: an earlier attempt's thread must not keep a retry looking alive.
      lastEventAt: sql<Date | null>`(select max(${runs.last_event_at}) from ${runs} where ${runs.issue_key} = ${issues.key} and ${runs.branch} = case when ${issues.attempt} > 1 then 'factory/' || ${issues.key} || '-a' || ${issues.attempt} else 'factory/' || ${issues.key} end)`.mapWith(
        (v: string | null) => (v ? new Date(v) : null),
      ),
    })
    .from(issues)
    .where(and(inArray(issues.stage, IN_FLIGHT), or(isNotNull(issues.t3_thread_id), isNotNull(issues.session_id))));
  const actions: string[] = [];
  for (const { issue, lastEventAt } of working) {
    const now = new Date();
    const action = watch(
      {
        stage: issue.stage,
        lastEventAt: lastEventAt ?? issue.updated_at,
        nudgedAt: issue.nudged_at,
        nudgedStage: issue.nudged_stage,
        thread: await threads.state(issue.t3_thread_id),
        now,
      },
      config.factory,
    );
    if (action.kind === "ok") continue;
    if (action.kind === "reset") {
      await db.update(issues).set({ nudged_at: null, nudged_stage: null }).where(eq(issues.linear_id, issue.linear_id));
      continue;
    }
    if (action.kind === "nudge") {
      const claimed = await db
        .update(issues)
        .set({ nudged_at: now, nudged_stage: issue.stage, updated_at: now })
        .where(
          and(
            eq(issues.linear_id, issue.linear_id),
            eq(issues.stage, issue.stage),
            or(isNull(issues.nudged_stage), ne(issues.nudged_stage, issue.stage)),
          ),
        )
        .returning({ key: issues.key });
      if (claimed.length === 0) continue;
      try {
        await threads.send(issue.t3_thread_id!, nudgeMessage(issue.key, issue.stage, action.idleMinutes));
      } catch (error) {
        await db
          .update(issues)
          .set({ nudged_at: issue.nudged_at, nudged_stage: issue.nudged_stage })
          .where(eq(issues.linear_id, issue.linear_id));
        throw error;
      }
      actions.push(`${issue.key}:nudged`);
      continue;
    }
    // Fail only the stage this pass looked at: a report that landed since then wins.
    const eventId = `watchdog:${issue.linear_id}:${issue.attempt}:${issue.stage_event_id ?? issue.stage}`;
    const summary = `Watchdog stopped this run: ${action.reason}.`;
    const failed = await db
      .update(issues)
      .set({ stage: "failed", stage_at: now, stage_summary: summary, question: null, stage_event_id: eventId, updated_at: now })
      .where(
        and(
          eq(issues.linear_id, issue.linear_id),
          eq(issues.stage, issue.stage),
          sql`${issues.stage_event_id} is not distinct from ${issue.stage_event_id}`,
        ),
      )
      .returning({ key: issues.key });
    if (failed.length === 0) continue;
    await postEvent({
      eventId,
      sessionId: issue.session_id ?? `watchdog:${issue.linear_id}`,
      at: now.getTime(),
      kind: "stage",
      stage: "failed",
      summary,
      issueKey: issue.key,
    });
    actions.push(`${issue.key}:failed`);
  }
  return actions;
}

/**
 * Rebuilds usage from transcripts for factory runs whose numbers fell behind, such as a run
 * interrupted before its Stop hook. It goes through the same greatest() projection as every
 * usage event, keyed on the totals, so replays and live updates cannot double count.
 */
export async function reconcileUsage() {
  const recent = await db
    .select()
    .from(runs)
    .where(and(isNotNull(runs.issue_key), gt(runs.last_event_at, new Date(Date.now() - 7 * 86_400_000))));
  const fixed: string[] = [];
  for (const run of recent) {
    const path = transcriptPathFor(run);
    if (!path || !existsSync(path)) continue;
    const usage = sumUsage(readTranscript(path));
    if (usage.model === "unknown") continue;
    const subagents = subagentTranscripts(path, run.session_id);
    const rows = await db.select().from(agents).where(eq(agents.session_id, run.session_id));
    const lags = (u: Usage, row: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number } | undefined) =>
      !row ||
      u.input > row.input_tokens ||
      u.output > row.output_tokens ||
      u.cacheRead > row.cache_read_tokens ||
      u.cacheWrite > row.cache_write_tokens;
    const behind = lags(usage, run) || subagents.some((s) => lags(s.usage, rows.find((r) => r.agent_id === s.agentId)));
    if (!behind) continue;
    const fingerprint = [usage, ...subagents.map((s) => s.usage)]
      .map((u) => `${u.input}.${u.output}.${u.cacheRead}.${u.cacheWrite}`)
      .join(":");
    await postEvent({
      eventId: `reconcile:${run.session_id}:${fingerprint}`,
      sessionId: run.session_id,
      // The transcript's own last write, so the watchdog never mistakes a reconcile for activity.
      at: Math.min(Math.floor(statSync(path).mtimeMs), run.last_event_at.getTime()),
      kind: "usage",
      usage,
      agents: subagents,
      transcriptPath: path,
    });
    fixed.push(run.issue_key!);
  }
  return fixed;
}

/** Backstop for the budget hook: a working issue over its cap fails even if its thread never reports it. */
export async function enforceBudget() {
  const working = await db.select().from(issues).where(inArray(issues.stage, IN_FLIGHT));
  const spend = await branchSpend(db, working.map((i) => attemptBranch(i.key, i.attempt)));
  const over: string[] = [];
  for (const issue of working) {
    const usd = spend[attemptBranch(issue.key, issue.attempt)] ?? 0;
    if (usd < config.factory.budgetUsd) continue;
    await postEvent({
      // Keyed on the stage it fails, so a run that reports again after this still gets failed again.
      eventId: `budget:${issue.linear_id}:${issue.attempt}:${issue.stage_event_id ?? issue.stage}`,
      sessionId: issue.session_id ?? `budget:${issue.linear_id}`,
      at: Date.now(),
      kind: "stage",
      stage: "failed",
      summary: `budget exceeded ($${usd.toFixed(2)} of $${config.factory.budgetUsd.toFixed(2)})`,
      issueKey: issue.key,
    });
    over.push(issue.key);
  }
  return over;
}

export async function writeBack() {
  const pending = await db
    .select()
    .from(issues)
    .where(
      and(
        isNotNull(issues.stage_event_id),
        or(isNull(issues.synced_event_id), ne(issues.synced_event_id, issues.stage_event_id)),
      ),
    );
  const synced: string[] = [];
  for (const issue of pending) {
    const written = await sourceFor("linear").writeBack(issue, { stage: issue.stage, eventId: issue.stage_event_id! });
    // Only this event counts as synced; a newer one that landed meanwhile goes next pass.
    await db
      .update(issues)
      .set({
        synced_event_id: issue.stage_event_id,
        ...(written?.sourceState ? { linear_state: written.sourceState } : {}),
      })
      .where(and(eq(issues.linear_id, issue.linear_id), eq(issues.stage_event_id, issue.stage_event_id!)));
    if (written) synced.push(`${issue.key}:${issue.stage}`);
  }
  return synced;
}

/** Claims ready issues up to the in-flight cap. The row insert is the claim; the advisory lock serializes claimers. */
export async function claim() {
  const ready = await sourceFor("linear").ready();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('marshal-factory linear-poll'))`);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(issues)
      .where(inArray(issues.stage, IN_FLIGHT));
    let inFlight = count;
    const claimed: string[] = [];
    for (const issue of ready) {
      if (inFlight >= config.factory.maxInFlight) break;
      const now = new Date();
      const inserted = await tx
        .insert(issues)
        .values({
          linear_id: issue.externalId,
          key: issue.key,
          title: issue.title,
          url: issue.url,
          description: issue.description,
          linear_state: issue.sourceState,
          labels: issue.labels,
          claimed_at: now,
          updated_at: now,
        })
        // A failed issue that got its label back is retried as a fresh attempt on a new branch.
        .onConflictDoUpdate({
          target: issues.linear_id,
          set: {
            attempt: sql`${issues.attempt} + 1`,
            previous_failure: sql`${issues.stage_summary}`,
            stage: "queued",
            stage_at: null,
            stage_summary: null,
            question: null,
            pr_url: null,
            stage_event_id: null,
            synced_event_id: null,
            t3_thread_id: null,
            session_id: null,
            nudged_at: null,
            nudged_stage: null,
            conflict_head: null,
            resume_context: null,
            stop_sent_to: null,
            answered_at: null,
            answer: null,
            title: issue.title,
            url: issue.url,
            description: issue.description,
            linear_state: issue.sourceState,
            labels: issue.labels,
            claimed_at: now,
            updated_at: now,
          },
          // No new attempt while a launch is pending or a stop is owed; see runner/binding.ts.
          setWhere: canReclaimSql,
        })
        .returning({ key: issues.key });
      if (inserted.length === 0) continue;
      inFlight++;
      claimed.push(issue.key);
    }
    return { claimed, inFlight };
  });
}

/** Moves claimed issues to In Progress with a pickup comment; retried every pass until it sticks. */
export async function announceClaims() {
  const unannounced = await db
    .select()
    .from(issues)
    .where(and(eq(issues.stage, "queued"), ne(issues.linear_state, "In Progress")));
  for (const issue of unannounced) {
    await sourceFor("linear").announceClaim(issue);
    await db
      .update(issues)
      .set({ linear_state: "In Progress", updated_at: new Date() })
      .where(eq(issues.linear_id, issue.linear_id));
  }
}

function launchMessage(issue: IssueRow) {
  return [
    `Work ${sourceFor("linear").describe(issue)}: ${issue.title}`,
    issue.url,
    "",
    "This is an unattended marshal-factory run. Follow the factory playbook in .agents/playbooks/factory.md. Report every stage with the report_stage tool, never ask in this thread, never merge.",
    "",
    "## Issue",
    "",
    issue.description?.trim() || "(The issue has no description.)",
    ...(issue.previous_failure
      ? [
          "",
          `This is attempt ${issue.attempt}. The previous attempt failed: ${issue.previous_failure} Start fresh from main on this branch.`,
        ]
      : []),
    ...(issue.resume_context
      ? [
          "",
          "An earlier run on this branch stopped with a question, and the reporter answered it. Treat the answer as the spec.",
          "",
          issue.resume_context,
        ]
      : []),
  ].join("\n");
}

export async function toLaunch() {
  const rows = await db
    .select()
    .from(issues)
    .where(
      and(
        // A waiting issue whose thread died and whose question was answered relaunches too.
        or(eq(issues.stage, "queued"), and(eq(issues.stage, "waiting"), isNotNull(issues.resume_context))),
        isNull(issues.t3_thread_id),
        isNull(issues.session_id),
      ),
    );
  return rows.map((issue) => ({
    key: issue.key,
    branch: attemptBranch(issue.key, issue.attempt),
    threadTitle: `${issue.key} ${issue.title}`,
    message: launchMessage(issue),
  }));
}

export async function cleanup(dryRun = false) {
  const all = await db.select().from(issues);
  const byKey = new Map(all.map((i) => [i.key, i]));
  // One after the other: both edit the same repo's worktree list and refs, and git locks them.
  const reports = [];
  for (const repo of config.factory.repos) {
    reports.push(await cleanupRepo(repo, byKey, config.factory.cleanupGraceDays, { dryRun }));
    reports.push(await cleanupSubagentWorktrees(repo, config.factory.subagentIdleHours, { dryRun }));
  }
  return {
    removed: reports.flatMap((r) => r.removed),
    held: reports.flatMap((r) => r.held),
    archive: reports.flatMap((r) => r.archive),
  };
}

/**
 * The one way the runner binds a thread to an issue. It delivers an owed stop right after, so a
 * stop recorded while the launch was pending reaches the thread however the binding happened.
 */
export async function bindThread(key: string, threadId: string) {
  const [bound] = await db
    .update(issues)
    .set({ t3_thread_id: threadId, updated_at: new Date() })
    .where(eq(issues.key, key))
    .returning({ linearId: issues.linear_id });
  if (!bound) throw new Error(`No claimed issue ${key}`);
  const stopped = await deliverStops(bound.linearId);
  return { bound: key, threadId, stopped: stopped.length > 0 };
}

/** True when GitHub has finished computing mergeability for every open factory PR. */
export async function pullRequestsSettled() {
  const open = await db.select().from(issues).where(and(eq(issues.stage, "pr"), isNotNull(issues.pr_url)));
  for (const issue of open) {
    if ((await prState(issue.pr_url!)).mergeable === "UNKNOWN") return false;
  }
  return true;
}

/**
 * The factory label came off, or the issue was canceled or deleted, in Linear. A run still in
 * flight or waiting is told to stop and marked failed; Linear already says what the human wants,
 * so nothing is written back.
 */
export async function stopIssue(linearId: string, detail: string) {
  // A stop intent can come from an unrelated label change; act only if the source really took the issue away.
  const check = await sourceFor("linear").confirmStop(linearId, detail);
  if (!check.stop) return "still labeled";
  const unlabeledInProgress = check.reopen;

  // A stage report can land between the read and the claim; read again and retry the claim.
  for (let tries = 0; tries < 3; tries++) {
    const [issue] = await db.select().from(issues).where(eq(issues.linear_id, linearId));
    if (!issue) return "not claimed";
    // Stopped already, perhaps by a retry whose side effects failed: finish them, they are idempotent.
    if (issue.stage === "failed" && issue.stage_event_id?.startsWith("stop:")) return finishStop(issue, unlabeledInProgress);
    // pr counts too: the thread is idle, but it would still get conflict send-backs.
    if (![...IN_FLIGHT, "waiting", "pr"].includes(issue.stage)) return "not running";

    const eventId = `stop:${issue.linear_id}:${issue.attempt}:${issue.stage_event_id ?? issue.stage}`;
    const now = new Date();
    const [stopped] = await db
      .update(issues)
      .set({ stage: "failed", stage_at: now, stage_summary: `Stopped: ${detail}.`, question: null, stage_event_id: eventId, synced_event_id: eventId, updated_at: now })
      .where(and(eq(issues.linear_id, linearId), eq(issues.stage, issue.stage), sql`${issues.stage_event_id} is not distinct from ${issue.stage_event_id}`))
      .returning();
    if (!stopped) continue;
    return finishStop(stopped, unlabeledInProgress);
  }
  throw new Error("the stage kept changing; the stop is retried");
}

/**
 * The stop is recorded on the issue, so it survives whatever happens to the thread binding. The
 * message goes to whichever thread the issue is bound to, once per thread: now if it is known,
 * or when a launch, its recovery or the thread's own session start records it.
 */
async function finishStop(issue: IssueRow, unlabeledInProgress: boolean) {
  await deliverStops(issue.linear_id);
  await postEvent({
    eventId: issue.stage_event_id,
    sessionId: issue.session_id ?? `stop:${issue.linear_id}`,
    at: issue.stage_at!.getTime(),
    kind: "stage",
    stage: "failed",
    summary: issue.stage_summary,
    issueKey: issue.key,
  });
  // Back to Todo, so adding the label again retries it as a new attempt, as for any failure.
  if (unlabeledInProgress) await sourceFor("linear").reopen(issue);
  return "stopped";
}

/** Marks a queued issue as being launched; false when another launch already holds it. */
export async function claimLaunch(key: string, marker: string) {
  const claimed = await db
    .update(issues)
    .set({ t3_thread_id: marker })
    .where(and(eq(issues.key, key), isNull(issues.t3_thread_id), isNull(issues.session_id)))
    .returning({ key: issues.key });
  return claimed.length > 0;
}

export async function releaseLaunch(key: string, marker: string) {
  await db.update(issues).set({ t3_thread_id: null }).where(and(eq(issues.key, key), eq(issues.t3_thread_id, marker)));
}

export async function pendingLaunches() {
  const rows = await db.select().from(issues).where(sql`${issues.t3_thread_id} like ${`${PENDING}%`}`);
  return rows.map((i) => ({ key: i.key, marker: i.t3_thread_id!, branch: attemptBranch(i.key, i.attempt), stage: i.stage }));
}


/** Sends the stop message to every stopped issue's thread that has not had it; claimed per thread. */
export async function deliverStops(linearId?: string) {
  const due = await db
    .select()
    .from(issues)
    .where(linearId ? and(stopDeliverableSql, eq(issues.linear_id, linearId)) : stopDeliverableSql);
  const delivered: string[] = [];
  for (const issue of due) {
    const threadId = issue.t3_thread_id!;
    const [claimed] = await db
      .update(issues)
      .set({ stop_sent_to: threadId })
      .where(and(eq(issues.linear_id, issue.linear_id), eq(issues.t3_thread_id, threadId), sql`${issues.stop_sent_to} is distinct from ${threadId}`))
      .returning({ key: issues.key });
    if (!claimed) continue;
    try {
      if ((await threads.state(threadId)) !== "gone") {
        await threads.send(
          threadId,
          `Stop working on ${issue.key}. ${issue.stage_summary} Do not push, do not open or update a PR. End the turn now.`,
        );
      }
    } catch (error) {
      await db
        .update(issues)
        .set({ stop_sent_to: issue.stop_sent_to })
        .where(and(eq(issues.linear_id, issue.linear_id), eq(issues.stop_sent_to, threadId)));
      throw error;
    }
    delivered.push(issue.key);
  }
  return delivered;
}

/**
 * A missed stop webhook must not leave a run going. Each tick reads every claimed, unfinished
 * issue from Linear in one query and records a stop through stopIssue, the webhook's own path,
 * for any that lost the label, was closed, or is gone. A failed fetch decides nothing.
 */
export async function reconcileStops({
  source = sourceFor("linear"),
  stop = stopIssue,
  only,
}: {
  source?: SourceAdapter<JobSource>;
  stop?: (linearId: string, detail: string) => Promise<string>;
  /** Restricts the check to these issues; the regression script uses it to stay off live ones. */
  only?: string[];
} = {}) {
  const unfinished = inArray(issues.stage, [...IN_FLIGHT, "waiting", "pr"]);
  const open = await db.select().from(issues).where(only ? and(unfinished, inArray(issues.linear_id, only)) : unfinished);
  if (open.length === 0) return [];
  let wanted: Awaited<ReturnType<typeof source.stopWanted>>;
  try {
    wanted = await source.stopWanted(open);
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
  const stopped = [];
  for (const { job, reason } of wanted) {
    stopped.push({ key: job.key, reason, result: await stop(job.linear_id, reason) });
  }
  return stopped;
}
