export const REPORT_SERVER = "factory-report";
export const REPORT_TOOL = "report_stage";
/** The name Claude Code gives the tool; hook payloads and PostToolUse matchers use it. */
export const REPORT_STAGE_TOOL = `mcp__${REPORT_SERVER}__${REPORT_TOOL}`;

/** factory/FAC-5 is the first attempt at FAC-5; factory/FAC-5-a2 the second. */
export function jobKeyFromBranch(branch: string | undefined) {
  return branch?.match(/^factory\/([A-Za-z][A-Za-z0-9]*-\d+)(?:-a\d+)?$/)?.[1];
}

export const attemptBranch = (key: string, attempt: number) =>
  attempt > 1 ? `factory/${key}-a${attempt}` : `factory/${key}`;

/** The session the factory-report MCP server reports under for an attempt branch, where no hooks name one. */
export const mcpSessionId = (branch: string) => `mcp:${branch}`;
export const isMcpSession = (sessionId: string) => sessionId.startsWith("mcp:");
