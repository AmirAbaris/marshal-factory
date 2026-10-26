import { z } from "zod";
import { HostGoneError, type JobHost } from "../lib/host";
import type { ThreadState } from "../lib/watchdog";
import { bindingOf } from "./binding";

/** Gone means T3 no longer has the thread, it is archived, or its worktree left the disk. */
async function showThread(threadId: string | null, host: JobHost): Promise<ThreadState> {
  if (!threadId) return "gone";
  // A launch in progress; the runner records the real id or clears the marker.
  if (bindingOf(threadId) === "pending") return "running";
  let stdout: string;
  try {
    ({ stdout } = await host.run(host.t3, ["thread", "show", threadId, "--json"], { timeoutMs: 20_000 }));
  } catch (error) {
    if (error instanceof HostGoneError) return "gone";
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
  if (thread.archived || (thread.worktreePath !== null && !(await host.exists(thread.worktreePath)))) return "gone";
  return thread.activeRunId ? "running" : "stopped";
}

/** How the runner reads and talks to a T3 thread; regressions replace either. */
export const threads = {
  state: showThread,
  async send(threadId: string, message: string, host: JobHost) {
    await host.run(host.t3, ["thread", "send", threadId, "-"], { input: message, timeoutMs: 30_000, maxBuffer: 16 * 1024 * 1024 });
  },
};
