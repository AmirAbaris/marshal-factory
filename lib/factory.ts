export const REPORT_SERVER = "factory-report";
export const REPORT_TOOL = "report_stage";
/** The name Claude Code gives the tool; hook payloads and PostToolUse matchers use it. */
export const REPORT_STAGE_TOOL = `mcp__${REPORT_SERVER}__${REPORT_TOOL}`;

export function issueKeyFromBranch(branch: string | undefined) {
  return branch?.match(/^factory\/([^/\s]+)/)?.[1];
}
