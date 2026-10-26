import { z } from "zod";
import { HostGoneError, type JobHost } from "../lib/host";
import type { ThreadState } from "../lib/watchdog";
import { bindingOf } from "./binding";

/** What `t3 thread show` says about a thread: its state, the status of its last run, and its last assistant message. */
export type ThreadRead = { state: ThreadState; status: string | null; lastMessage: string | null };

const GONE: ThreadRead = { state: "gone", status: null, lastMessage: null };

/** Gone means T3 no longer has the thread, it is archived, or its worktree left the disk. */
async function readThread(threadId: string | null, host: JobHost): Promise<ThreadRead> {
  if (!threadId) return GONE;
  // A launch in progress; the runner records the real id or clears the marker.
  if (bindingOf(threadId) === "pending") return { state: "running", status: null, lastMessage: null };
  let stdout: string;
  try {
    ({ stdout } = await host.run(host.t3, ["thread", "show", threadId, "--json"], { timeoutMs: 20_000 }));
  } catch (error) {
    if (error instanceof HostGoneError) return GONE;
    // Only T3 saying the thread is gone counts as gone; a timeout or crash must not start a second thread.
    const output = String((error as { stdout?: string }).stdout ?? "") + String((error as { stderr?: string }).stderr ?? "");
    if (output.includes("no longer available")) return GONE;
    throw error;
  }
  const { thread, messages } = z
    .object({
      thread: z.object({
        archived: z.boolean(),
        worktreePath: z.string().nullable(),
        activeRunId: z.string().nullable(),
        status: z.string().optional(),
      }),
      messages: z.array(z.object({ role: z.string(), text: z.string() })).optional(),
    })
    .parse(JSON.parse(stdout));
  if (thread.archived || (thread.worktreePath !== null && !(await host.exists(thread.worktreePath)))) return GONE;
  const lastMessage = messages?.findLast((m) => m.role === "assistant")?.text ?? null;
  return { state: thread.activeRunId ? "running" : "stopped", status: thread.status ?? null, lastMessage };
}

/** How the runner reads and talks to a T3 thread; regressions replace any of them. */
export const threads = {
  read: readThread,
  state: async (threadId: string | null, host: JobHost) => (await threads.read(threadId, host)).state,
  async send(threadId: string, message: string, host: JobHost) {
    await host.run(host.t3, ["thread", "send", threadId, "-"], { input: message, timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
  },
};
