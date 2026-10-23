import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../lib/config";
import { REPORT_SERVER, REPORT_STAGE_TOOL } from "../lib/factory";

// Wires a target repo to this checkout: hooks, the factory-report MCP server, the playbook.
// Re-running converges on the same files and merges with what the repo already has.

type Json = Record<string, unknown>;
type HookEntry = {
  matcher?: string;
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[];
};

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const reporter = { type: "command", command: `bun "${join(root, "hooks/report.ts")}"`, async: true, timeout: 20 };
// Synchronous on purpose: it has to answer before the tool runs.
const budget = { type: "command", command: `bun "${join(root, "hooks/budget.ts")}"`, timeout: 10 };

/** Ours, per event, in order. PostToolUse takes every tool so the reporter can send usage snapshots. */
const HOOKS: Record<string, HookEntry[]> = {
  SessionStart: [{ hooks: [reporter] }],
  PreToolUse: [{ hooks: [budget] }, { matcher: "Agent", hooks: [reporter] }],
  PostToolUse: [{ hooks: [reporter] }],
  SubagentStop: [{ hooks: [reporter] }],
  Stop: [{ hooks: [reporter] }],
  SessionEnd: [{ hooks: [reporter] }],
};

const readJson = (path: string): Json =>
  existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Json) : {};

const isOurs = (entry: HookEntry) =>
  entry.hooks?.some((hook) => /hooks\/(report|budget)\.ts/.test(hook.command ?? ""));

function withHooks(settings: Json): Json {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  for (const [event, ours] of Object.entries(HOOKS)) {
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

// Cleanup walks the repos listed in the config; the file holds secrets, so it stays owner-only.
const configPath = CONFIG_PATH;
const config = readJson(configPath);
const factory = (config.factory as Json | undefined) ?? {};
const repo = resolve(target);
if (!((factory.repos as string[] | undefined) ?? []).includes(repo)) {
  factory.repos = [...((factory.repos as string[] | undefined) ?? []), repo];
  writeFileSync(configPath, json({ ...config, factory }), { mode: 0o600 });
  console.log(`added     ${repo} to factory.repos in ${configPath}`);
}

const settingsPath = join(target, ".claude/settings.json");
write(settingsPath, json(withHooks(readJson(settingsPath))));
const mcpPath = join(target, ".mcp.json");
write(mcpPath, json(withServer(readJson(mcpPath))));
write(
  join(target, ".agents/playbooks/factory.md"),
  readFileSync(join(root, "playbooks/factory.md"), "utf8"),
);
