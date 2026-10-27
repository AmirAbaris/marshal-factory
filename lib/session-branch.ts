import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SESSIONS = join(homedir(), ".cache/marshal-factory/sessions");
const sessionFile = (sessionId: string) => join(SESSIONS, sessionId.replace(/[^\w-]/g, "_"));

/**
 * Subagents can run in their own worktree on a non-factory branch, so the factory branch is looked
 * up by session as well as from the cwd. The reporter records it whenever the main session is on one.
 */
export function rememberSessionBranch(sessionId: string, branch: string) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(sessionFile(sessionId), branch);
}

export function sessionBranch(sessionId: string | undefined) {
  if (!sessionId) return undefined;
  const file = sessionFile(sessionId);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}
