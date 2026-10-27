import { join } from "node:path";
import { REPORT_SERVER, REPORT_STAGE_TOOL } from "./factory";

// How a target repo reaches a factory checkout: Claude Code hooks, the factory-report MCP server.
// Pure, so the installer and the sandbox launch wire the same way from different factory roots.

export type Json = Record<string, unknown>;
type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
};

/** Ours, per event, in order. PostToolUse takes every tool so the reporter can send usage snapshots. */
function hooksFor(root: string): Record<string, HookEntry[]> {
  const reporter = { type: "command", command: `bun "${join(root, "hooks/report.ts")}"`, async: true, timeout: 20 };
  return {
    SessionStart: [{ hooks: [reporter] }],
    PreToolUse: [{ matcher: "Agent", hooks: [reporter] }],
    PostToolUse: [{ hooks: [reporter] }],
    SubagentStop: [{ hooks: [reporter] }],
    Stop: [{ hooks: [reporter] }],
    SessionEnd: [{ hooks: [reporter] }],
  };
}

/** hooks/budget.ts counts as ours so rewiring a repo from before the cap was removed drops it. */
const isOurs = (entry: HookEntry) => entry.hooks?.some((hook) => /hooks\/(report|budget)\.ts/.test(hook.command ?? ""));

export function withHooks(settings: Json, root: string): Json {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  for (const [event, ours] of Object.entries(hooksFor(root))) {
    hooks[event] = [...(hooks[event] ?? []).filter((entry) => !isOurs(entry)), ...ours];
  }
  const permissions = (settings.permissions as Json) ?? {};
  const allow = new Set([...((permissions.allow as string[]) ?? []), REPORT_STAGE_TOOL]);
  const enabled = new Set([...((settings.enabledMcpjsonServers as string[]) ?? []), REPORT_SERVER]);
  return {
    ...settings,
    enabledMcpjsonServers: [...enabled],
    permissions: { ...permissions, allow: [...allow] },
    hooks,
  };
}

export const reportServer = (root: string) => ({ command: "bun", args: [join(root, "mcp/factory-report.ts")] });

/** Claude Code's hooks report its stages, so its server only validates. */
export function withServer(mcp: Json, root: string): Json {
  return { ...mcp, mcpServers: { ...((mcp.mcpServers as Json) ?? {}), [REPORT_SERVER]: { ...reportServer(root), env: { FACTORY_REPORTER: "hook" } } } };
}

/** The factory checkouts a repo's committed wiring points at, read from its settings and .mcp.json text. */
export function wiredRoots(...files: (string | null)[]) {
  const roots = new Set<string>();
  for (const text of files) {
    for (const match of (text ?? "").matchAll(/(\/[^"\s]*?)\/(?:hooks\/(?:report|budget)|mcp\/factory-report)\.ts/g)) roots.add(match[1]!);
  }
  return [...roots];
}

export const json = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;
