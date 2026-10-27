export const REPORT_SERVER = "factory-report";
export const REPORT_TOOL = "report_stage";
/** The name Claude Code gives the tool; hook payloads and PostToolUse matchers use it. */
export const REPORT_STAGE_TOOL = `mcp__${REPORT_SERVER}__${REPORT_TOOL}`;

// A job key names a job in every source and is its branch name: `<PREFIX>-<n>` or
// `<PREFIX>-<scope>-<n>`. PREFIX names the source's namespace (a Linear team key such as FAC; GH
// for GitHub issues), scope is an optional lowercase slug (a repo name) and n the source's number.
// A key always ends in digits, so the attempt suffix `-a<n>` never reads as part of one.
const KEY = "[A-Za-z][A-Za-z0-9]*(?:-[a-z0-9]+)*-\\d+";
const KEY_PATTERN = new RegExp(`^${KEY}$`);
const BRANCH_PATTERN = new RegExp(`^factory/(${KEY})(?:-a(\\d+))?$`);
export const MAX_KEY_LENGTH = 64;

export const isJobKey = (value: string) => value.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(value);

/** Lowercase letters and digits between single hyphens, as a key's scope takes them. */
const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** The key for a source's item: `jobKey("FAC", 123)` is FAC-123, `jobKey("GH", 42, "acme/Web App")` GH-acme-web-app-42. */
export function jobKey(prefix: string, number: number | string, scope?: string) {
  const key = [prefix, ...(scope ? [slug(scope)] : []), String(number)].filter(Boolean).join("-");
  if (!/^[A-Z][A-Z0-9]*$/.test(prefix) || !isJobKey(key)) throw new Error(`cannot make a job key from ${prefix}, ${scope ?? "no scope"}, ${number}`);
  return key;
}

/** factory/FAC-5 is the first attempt at FAC-5; factory/FAC-5-a2 the second. */
export const attemptBranch = (key: string, attempt: number) =>
  attempt > 1 ? `factory/${key}-a${attempt}` : `factory/${key}`;

/** The job and attempt an attempt branch is for; undefined for any other branch. */
export function parseBranch(branch: string | undefined): { key: string; attempt: number } | undefined {
  const match = branch?.match(BRANCH_PATTERN);
  if (!match || match[1]!.length > MAX_KEY_LENGTH) return undefined;
  return { key: match[1]!, attempt: match[2] ? Number(match[2]) : 1 };
}

/** The session the factory-report MCP server reports under for an attempt branch, where no hooks name one. */
export const mcpSessionId = (branch: string) => `mcp:${branch}`;
export const isMcpSession = (sessionId: string) => sessionId.startsWith("mcp:");
