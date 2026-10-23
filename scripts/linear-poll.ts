import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { and, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { IssueRow } from "../db/schema";
import type { Stage } from "../lib/events";
import { linearClient, type LinearClient } from "../lib/linear";
import {
  claimCommentId,
  claimReplies,
  planResume,
  qaBlock,
  resumeCommentId,
  resumeMessage,
  stageCommentId,
} from "../lib/resume";

// Usage:
//   bun scripts/linear-poll.ts                     resume, sync, claim, print the issues to launch as JSON
//   bun scripts/linear-poll.ts --sync              write stage changes back to Linear, nothing else
//   bun scripts/linear-poll.ts --attach KEY THREAD record the T3 thread launched for an issue

process.chdir(join(import.meta.dirname, ".."));
process.loadEnvFile(".env.local");
const { db } = await import("../db/client");
const { issues } = await import("../db/schema");

const configSchema = z.object({
  linearApiKey: z.string().min(1),
  ingestUrl: z.url(),
  secret: z.string().min(1),
  factory: z
    .object({
      teamKey: z.string().default("FAC"),
      label: z.string().default("factory"),
      maxInFlight: z.number().int().positive().default(2),
    })
    .prefault({}),
});
const config = configSchema.parse(
  JSON.parse(readFileSync(join(homedir(), ".config/marshal-factory/config.json"), "utf8")),
);
const linear = linearClient(config.linearApiKey);

/** Stages where a thread is working; waiting, pr, merged and failed free the slot. */
const IN_FLIGHT: Stage[] = ["queued", "triage", "investigating", "implementing", "verifying"];

type Team = Awaited<ReturnType<LinearClient["team"]>>;

const stateId = (team: Team, name: string) => {
  const state = team.states.find((s) => s.name === name);
  if (!state) throw new Error(`Linear team ${config.factory.teamKey} has no state ${name}`);
  return state.id;
};

/** What reaches Linear when an issue enters a stage. Stages without an entry stay in the panel. */
const WRITE_BACK: Partial<Record<Stage, { state?: string; comment?: (issue: IssueRow) => string }>> = {
  pr: {
    state: "In Review",
    comment: (i) => `marshal-factory opened a pull request: ${i.pr_url}\n\n${i.stage_summary ?? ""}`.trim(),
  },
  waiting: {
    comment: (i) =>
      `marshal-factory stopped and needs an answer before it can continue:\n\n${i.question ?? i.stage_summary}`,
  },
  failed: { comment: (i) => `marshal-factory gave up on this issue: ${i.stage_summary}` },
  merged: { state: "Done" },
};

const run = promisify(execFile);
const T3 = process.env.T3CODE_CLI_PATH ?? join(homedir(), ".t3/bin/t3");

/** Records the id before posting, so a crash in between can never make our own comment look like a reply. */
async function postComment(issue: IssueRow, id: string, body: string) {
  await db
    .update(issues)
    .set({
      factory_comment_ids: sql`case when ${issues.factory_comment_ids} ? ${id} then ${issues.factory_comment_ids} else ${issues.factory_comment_ids} || jsonb_build_array(${id}::text) end`,
    })
    .where(eq(issues.linear_id, issue.linear_id));
  await linear.comment(issue.linear_id, id, body);
}

async function prState(url: string) {
  const { stdout } = await run("gh", ["pr", "view", url, "--json", "state"], { timeout: 20_000 });
  return z.object({ state: z.string() }).parse(JSON.parse(stdout)).state;
}

async function detectMerges() {
  const open = await db
    .select()
    .from(issues)
    .where(and(isNotNull(issues.pr_url), ne(issues.stage, "merged")));
  for (const issue of open) {
    if ((await prState(issue.pr_url!)) !== "MERGED") continue;
    const now = new Date();
    await db
      .update(issues)
      .set({
        stage: "merged",
        stage_at: now,
        stage_summary: `Merged ${issue.pr_url}`,
        question: null,
        stage_event_id: `merged:${issue.pr_url}`,
        updated_at: now,
      })
      .where(eq(issues.linear_id, issue.linear_id));
  }
}

async function postEvent(event: Record<string, unknown>) {
  const res = await fetch(config.ingestUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ingest answered ${res.status}: ${await res.text()}`);
}

/** A thread can take the answer if T3 still has it and its worktree is on disk. */
async function threadAlive(threadId: string | null) {
  if (!threadId) return false;
  let stdout: string;
  try {
    ({ stdout } = await run(T3, ["thread", "show", threadId, "--json"], { timeout: 20_000 }));
  } catch (error) {
    // Only T3 saying the thread is gone counts as gone; a timeout or crash must not start a second thread.
    const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
    if (output.includes("no longer available")) return false;
    throw error;
  }
  const { thread } = z
    .object({ thread: z.object({ archived: z.boolean(), worktreePath: z.string().nullable() }) })
    .parse(JSON.parse(stdout));
  return !thread.archived && (thread.worktreePath === null || existsSync(thread.worktreePath));
}

async function sendToThread(threadId: string, message: string) {
  await new Promise<void>((resolve, reject) => {
    const child = execFile(T3, ["thread", "send", threadId, "-"], { timeout: 30_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
    child.stdin!.end(message);
  });
}

/**
 * Hands answers to waiting questions back to the run that asked. The reply ids are claimed in
 * the database before anything is sent, so a replayed or concurrent pass never delivers twice.
 */
async function resumeAnswered() {
  const waiting = await db.select().from(issues).where(eq(issues.stage, "waiting"));
  const resumed: string[] = [];
  for (const issue of waiting) {
    const plan = planResume(issue, await linear.issueWithComments(issue.linear_id));
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
    const ackId = resumeCommentId(issue.linear_id, replyIds);
    const alive = await threadAlive(issue.t3_thread_id);
    // A dead thread is unlinked in the same update that claims the replies, so the relaunch
    // cannot be lost to a later failure in this pass.
    const relaunch = alive ? undefined : qaBlock(plan.question, plan.answer);
    if (!(await claimReplies(db, issue.linear_id, replyIds, plan.answer, now, relaunch))) continue;

    if (alive) {
      try {
        await sendToThread(issue.t3_thread_id!, resumeMessage(issue.key, plan.question, plan.answer));
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
    await postComment(issue, ackId, "Answer received, resuming.");
    resumed.push(`${issue.key}:${alive ? "sent" : "relaunch"}`);
  }
  return resumed;
}

async function writeBack(team: Team) {
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
    const action = WRITE_BACK[issue.stage];
    if (action?.state) await linear.setState(issue.linear_id, stateId(team, action.state));
    if (action?.comment) {
      await postComment(issue, stageCommentId(issue.linear_id, issue.stage_event_id!), action.comment(issue));
    }
    // Only this event counts as synced; a newer one that landed meanwhile goes next pass.
    await db
      .update(issues)
      .set({
        synced_event_id: issue.stage_event_id,
        ...(action?.state ? { linear_state: action.state } : {}),
      })
      .where(and(eq(issues.linear_id, issue.linear_id), eq(issues.stage_event_id, issue.stage_event_id!)));
    if (action) synced.push(`${issue.key}:${issue.stage}`);
  }
  return synced;
}

/** Claims ready issues up to the in-flight cap. The row insert is the claim; the advisory lock serializes pollers. */
async function claim() {
  const ready = await linear.readyIssues(config.factory.teamKey, config.factory.label);
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
          linear_id: issue.id,
          key: issue.identifier,
          title: issue.title,
          url: issue.url,
          description: issue.description,
          linear_state: issue.state.name,
          labels: issue.labels.nodes.map((l) => l.name),
          claimed_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .returning({ key: issues.key });
      if (inserted.length === 0) continue;
      inFlight++;
      claimed.push(issue.identifier);
    }
    return { claimed, inFlight };
  });
}

/** Moves claimed issues to In Progress with a pickup comment; retried every pass until it sticks. */
async function announceClaims(team: Team) {
  const unannounced = await db
    .select()
    .from(issues)
    .where(and(eq(issues.stage, "queued"), ne(issues.linear_state, "In Progress")));
  for (const issue of unannounced) {
    await linear.setState(issue.linear_id, stateId(team, "In Progress"));
    await postComment(issue, claimCommentId(issue.linear_id), "Picked up by marshal-factory.");
    await db
      .update(issues)
      .set({ linear_state: "In Progress", updated_at: new Date() })
      .where(eq(issues.linear_id, issue.linear_id));
  }
}

function launchMessage(issue: IssueRow) {
  return [
    `Work Linear issue ${issue.key}: ${issue.title}`,
    issue.url,
    "",
    "This is an unattended marshal-factory run. Follow the factory playbook in .agents/playbooks/factory.md. Report every stage with the report_stage tool, never ask in this thread, never merge.",
    "",
    "## Issue",
    "",
    issue.description?.trim() || "(The issue has no description.)",
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

async function toLaunch() {
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
    branch: `factory/${issue.key}`,
    threadTitle: `${issue.key} ${issue.title}`,
    message: launchMessage(issue),
  }));
}

async function attach(key: string, threadId: string) {
  const updated = await db
    .update(issues)
    .set({ t3_thread_id: threadId, updated_at: new Date() })
    .where(eq(issues.key, key))
    .returning({ key: issues.key });
  if (updated.length === 0) throw new Error(`No claimed issue ${key}`);
  return { attached: key, threadId };
}

async function main(args: string[]) {
  if (args[0] === "--attach") {
    const [, key, threadId] = args;
    if (!key || !threadId) throw new Error("usage: --attach <KEY> <threadId>");
    return attach(key, threadId);
  }
  const team = await linear.team(config.factory.teamKey);
  await detectMerges();
  if (args[0] === "--sync") return { synced: await writeBack(team) };
  const resumed = await resumeAnswered();
  const synced = await writeBack(team);
  const { claimed, inFlight } = await claim();
  await announceClaims(team);
  return { claimed, resumed, synced, inFlight, maxInFlight: config.factory.maxInFlight, launch: await toLaunch() };
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  process.exit();
}
