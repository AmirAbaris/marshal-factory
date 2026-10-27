import { readFileSync } from "node:fs";
import { loadLimits } from "../lib/config";
import { parseBranch, REPORT_STAGE_TOOL } from "../lib/factory";
import { currentBranch } from "../lib/git-head";
import { readSpend, sessionBranch } from "../lib/spend-cache";

// Synchronous PreToolUse hook: once a factory job has spent its attempt's budget, every tool call except
// report_stage is blocked. It reads only local files, so it stays fast, and it exits 0 for any
// session that is not on a factory branch or whenever something goes wrong.

function verdict(): string | undefined {
  const input = JSON.parse(readFileSync(0, "utf8")) as { tool_name?: string; cwd?: string; session_id?: string };
  if (input.tool_name === REPORT_STAGE_TOOL) return undefined;
  const cwdBranch = currentBranch(input.cwd ?? process.cwd());
  const branch = parseBranch(cwdBranch) ? cwdBranch : sessionBranch(input.session_id);
  const key = parseBranch(branch)?.key;
  if (!branch || !key) return undefined;
  const spent = readSpend(branch);
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
