import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadLimits } from "../lib/config";
import { issueKeyFromBranch, REPORT_STAGE_TOOL } from "../lib/factory";
import { readSpend } from "../lib/spend-cache";

// Synchronous PreToolUse hook: once a factory issue has spent its budget, every tool call except
// report_stage is blocked. It reads only local files, so it stays fast, and it exits 0 for any
// session that is not on a factory branch or whenever something goes wrong.

/** Reads the branch from .git without spawning git; worktrees keep HEAD behind a gitdir pointer. */
function currentBranch(cwd: string) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const pointer = statSync(dotGit).isDirectory()
        ? undefined
        : readFileSync(dotGit, "utf8").match(/^gitdir: (.+)$/m)?.[1];
      const gitDir = pointer ? resolve(dir, pointer.trim()) : dotGit;
      return readFileSync(join(gitDir, "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1];
    }
    if (dirname(dir) === dir) return undefined;
  }
}

function verdict(): string | undefined {
  const input = JSON.parse(readFileSync(0, "utf8")) as { tool_name?: string; cwd?: string };
  if (input.tool_name === REPORT_STAGE_TOOL) return undefined;
  const key = issueKeyFromBranch(currentBranch(input.cwd ?? process.cwd()));
  if (!key) return undefined;
  const spent = readSpend(key);
  if (!spent) return undefined;
  const cap = loadLimits().budgetUsd;
  if (spent.usd < cap) return undefined;
  const money = (n: number) => `$${n.toFixed(2)}`;
  return [
    `marshal-factory budget exceeded for ${key}: ${money(spent.usd)} spent of the ${money(cap)} cap.`,
    `Stop now. Call report_stage with stage "failed" and summary "budget exceeded (${money(spent.usd)} of ${money(cap)})", then end the turn. Every other tool call is blocked.`,
  ].join(" ");
}

let message: string | undefined;
try {
  message = verdict();
} catch {
  message = undefined;
}
if (message) {
  process.stderr.write(message);
  process.exit(2);
}
process.exit(0);
