import { z } from "zod";
import { HostGoneError, type JobHost } from "../lib/host";
import type { ThreadState } from "../lib/watchdog";
import { bindingOf } from "./binding";
import { interruptThread, listSubagents, sendMessage, showThread as showCli, type InterruptOutcome, type SubagentThread } from "../lib/t3-client";

/** What `t3 thread show` says about a thread: its state, the status of its last run, and its last assistant message. */
export type ThreadRead = { state: ThreadState; status: string | null; lastMessage: string | null };

/** The thread as a stop sees it: whether a run is active, and the project its subagent threads are listed under. */
export type ThreadActivity = { state: ThreadState; activeRunId: string | null; projectId: string | null };

export type { InterruptOutcome, SubagentThread };

/** Run statuses that are not over; a subagent thread in one of them still works or waits. */
export const ACTIVE_RUN_STATUSES = ["preparing", "queued", "starting", "running", "waiting"];

const GONE: ThreadRead = { state: "gone", status: null, lastMessage: null };

const shown = z.object({
  thread: z.object({
    archived: z.boolean(),
    worktreePath: z.string().nullable(),
    activeRunId: z.string().nullable(),
    status: z.string().nullish().catch(null),
    projectId: z.string().nullish().catch(null),
  }),
  messages: z.array(z.unknown()).nullish().catch(null),
});

/** Gone means T3 no longer has the thread, it is archived, or its worktree left the disk. */
async function showThread(threadId: string | null, host: JobHost): Promise<{ read: ThreadRead; activity: ThreadActivity }> {
  const gone: { read: ThreadRead; activity: ThreadActivity } = { read: GONE, activity: { state: "gone", activeRunId: null, projectId: null } };
  if (!threadId) return gone;
  // A launch in progress; the runner records the real id or clears the marker.
  if (bindingOf(threadId) === "pending") return { read: { state: "running", status: null, lastMessage: null }, activity: { state: "running", activeRunId: null, projectId: null } };
  let raw: unknown;
  try {
    raw = await showCli(host, threadId);
  } catch (error) {
    if (error instanceof HostGoneError) return gone;
    // Only T3 saying the thread is gone counts as gone; a timeout or crash must not start a second thread.
    const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
    if (output.includes("no longer available")) return gone;
    throw error;
  }
  const { thread, messages } = shown.parse(raw);
  const state = thread.activeRunId ? "running" : "stopped";
  // An archived thread or a deleted worktree can still have a run going, so a stop looks at the run itself.
  const activity: ThreadActivity = { state, activeRunId: thread.activeRunId, projectId: thread.projectId ?? null };
  if (thread.archived || (thread.worktreePath !== null && !(await host.exists(thread.worktreePath)))) return { read: GONE, activity };
  const assistant = z.object({ role: z.literal("assistant"), text: z.string() });
  const lastMessage = (messages ?? []).flatMap((m) => {
    const parsed = assistant.safeParse(m);
    return parsed.success ? [parsed.data.text] : [];
  }).at(-1) ?? null;
  return { read: { state, status: thread.status ?? null, lastMessage }, activity };
}

/** How the runner reads and talks to a T3 thread; regressions replace any of them. */
export const threads = {
  read: async (threadId: string | null, host: JobHost) => (await showThread(threadId, host)).read,
  activity: async (threadId: string | null, host: JobHost) => (await showThread(threadId, host)).activity,
  state: async (threadId: string | null, host: JobHost) => (await threads.read(threadId, host)).state,
  send: (threadId: string, message: string, host: JobHost) => sendMessage(host, threadId, message),
  subagents: (threadId: string, projectId: string, host: JobHost) => listSubagents(host, threadId, projectId),
  interrupt: (threadId: string, requestId: string, reason: string, host: JobHost) => interruptThread(host, threadId, requestId, reason),
};
