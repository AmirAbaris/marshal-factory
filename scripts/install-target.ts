import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPORT_SERVER, REPORT_STAGE_TOOL } from "../lib/factory";

// Wires a target repo to this checkout: hooks, the factory-report MCP server, the playbook.
// Re-running converges on the same files and merges with what the repo already has.

type Json = Record<string, unknown>;
type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
};

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const reporter = `bun "${join(root, "hooks/report.ts")}"`;

const HOOKS: Record<string, string | undefined> = {
  SessionStart: undefined,
  PreToolUse: "Agent",
  PostToolUse: `Agent|${REPORT_STAGE_TOOL}`,
  SubagentStop: undefined,
  Stop: undefined,
  SessionEnd: undefined,
};

const readJson = (path: string): Json =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {};

const isReporter = (entry: HookEntry) =>
  entry.hooks?.some((hook) => hook.command?.includes("hooks/report.ts"));

function withHooks(settings: Json): Json {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  for (const [event, matcher] of Object.entries(HOOKS)) {
    const ours: HookEntry = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: reporter, async: true, timeout: 20 }],
    };
    hooks[event] = [...(hooks[event] ?? []).filter((entry) => !isReporter(entry)), ours];
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

function withServer(mcp: Json): Json {
  const servers = (mcp.mcpServers as Json) ?? {};
  return {
    ...mcp,
    mcpServers: {
      ...servers,
      [REPORT_SERVER]: { command: "bun", args: [join(root, "mcp/factory-report.ts")] },
    },
  };
}

function write(path: string, content: string) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    console.log(`unchanged ${path}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  console.log(`wrote     ${path}`);
}

const json = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;

const target = process.argv[2];
if (!target || !existsSync(join(target, ".git"))) {
  console.error("usage: bun scripts/install-target.ts <path to a git repo>");
  process.exit(1);
}

const settingsPath = join(target, ".claude/settings.json");
write(settingsPath, json(withHooks(readJson(settingsPath))));
const mcpPath = join(target, ".mcp.json");
write(mcpPath, json(withServer(readJson(mcpPath))));
write(
  join(target, ".agents/playbooks/factory.md"),
  readFileSync(join(root, "playbooks/factory.md"), "utf8"),
);
