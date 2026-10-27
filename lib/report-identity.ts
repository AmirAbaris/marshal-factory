import { attemptBranch, mcpSessionId, parseBranch } from "./factory";
import { currentBranch } from "./git-head";

// Who the factory-report MCP server reports for. Claude Code's hooks see the session id and turn a
// report_stage call into the stage event, so under Claude the server only validates. Any other
// harness (Codex) has no hooks, so the server posts the event itself, under a session of its own
// per attempt branch: `mcp:factory/FAC-5-a2`.

/** `FACTORY_REPORTER` in the server's env: "hook" where hooks report (Claude Code), "mcp" where the server must. */
export function mcpPosts(env: Readonly<Record<string, string | undefined>>) {
  switch (env.FACTORY_REPORTER) {
    case "mcp":
      return true;
    case "hook":
      return false;
    default:
      // Wiring that predates the variable: Claude Code marks every process it starts.
      return env.CLAUDECODE !== "1";
  }
}

export type McpIdentity = { jobKey: string; branch: string; sessionId: string; repo?: string };

/**
 * The job the server reports for: `FACTORY_JOB_KEY` and `FACTORY_ATTEMPT`, which a sandbox launch
 * sets, else the factory branch checked out in its working directory.
 */
export function mcpIdentity(env: Readonly<Record<string, string | undefined>>, cwd: string, branchOf: (cwd: string) => string | undefined = currentBranch): McpIdentity | undefined {
  const attempt = Number(env.FACTORY_ATTEMPT ?? "1");
  const branch = env.FACTORY_JOB_KEY ? (Number.isInteger(attempt) && attempt > 0 ? attemptBranch(env.FACTORY_JOB_KEY, attempt) : undefined) : branchOf(cwd);
  const jobKey = parseBranch(branch)?.key;
  if (!branch || !jobKey) return undefined;
  return { jobKey, branch, sessionId: env.FACTORY_SESSION_ID || mcpSessionId(branch), ...(env.FACTORY_REPO && { repo: env.FACTORY_REPO }) };
}

/** The server's env for a sandbox job's Codex: it posts, for this job's attempt. */
export const codexReportEnv = (job: { key: string; attempt: number; repo: string }) => ({
  FACTORY_REPORTER: "mcp",
  FACTORY_JOB_KEY: job.key,
  FACTORY_ATTEMPT: String(job.attempt),
  FACTORY_REPO: job.repo.split("/").pop()!,
});
