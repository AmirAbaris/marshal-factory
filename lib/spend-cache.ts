import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The reporter writes what ingest last said an issue has spent; the budget hook only reads it.
const DIR = join(homedir(), ".cache/marshal-factory/spend");

export type CachedSpend = { usd: number; at: number };

const fileFor = (issueKey: string) => join(DIR, `${issueKey.replace(/[^\w-]/g, "_")}.json`);

export function readSpend(issueKey: string): CachedSpend | undefined {
  const file = fileFor(issueKey);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as CachedSpend;
}

export function writeSpend(spend: Record<string, number>, at = Date.now()) {
  mkdirSync(DIR, { recursive: true });
  for (const [key, usd] of Object.entries(spend)) {
    // Rename is atomic, so the budget hook never reads a half-written file.
    const tmp = `${fileFor(key)}.${process.pid}`;
    writeFileSync(tmp, JSON.stringify({ usd, at }));
    renameSync(tmp, fileFor(key));
  }
}

const SESSIONS = join(homedir(), ".cache/marshal-factory/sessions");
const sessionFile = (sessionId: string) => join(SESSIONS, sessionId.replace(/[^\w-]/g, "_"));

/**
 * Subagents can run in their own worktree on a non-factory branch, so the issue is looked up by
 * session as well as by branch. The reporter records it whenever the main session is on one.
 */
export function rememberSessionIssue(sessionId: string, issueKey: string) {
  mkdirSync(SESSIONS, { recursive: true });
  writeFileSync(sessionFile(sessionId), issueKey);
}

export function sessionIssue(sessionId: string | undefined) {
  if (!sessionId) return undefined;
  const file = sessionFile(sessionId);
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined;
}
