import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { stageReportSchema, type FactoryEvent, type Usage } from "../lib/events";
import { parseBranch, REPORT_STAGE_TOOL } from "../lib/factory";
import { localHost } from "../lib/host";
import { readIngestTarget, reportEvents } from "../lib/outbox";
import { screenshotEvents, unreadable } from "../lib/screenshot-files";
import { rememberSessionBranch, sessionBranch } from "../lib/session-branch";
import { mainTranscript, readTranscript, subagentTranscripts, sumUsage } from "../lib/transcript";

const run = promisify(execFile);

// T3 exports its CLI path to the sessions it starts.
const T3 = process.env.T3CODE_CLI_PATH ?? "t3";
/** How long one hook spends delivering its event and the backlog; what is left waits in the outbox. */
const FLUSH_BUDGET_MS = 4000;
const SUBPROCESS_TIMEOUT_MS = 3000;
const LAST_MESSAGE_MAX = 500;

type HookInput = Record<string, unknown> & {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  agent_id?: string;
  agent_type?: string;
};

const str = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : undefined;

const SETTLE_POLL_MS = 250;
const SETTLE_TRIES = 12;

/**
 * Stop hooks fire before Claude Code has flushed the final assistant lines, so wait
 * until the transcript holds usage and has stopped growing.
 */
async function readSettled(path: string | undefined) {
  if (!path) return "";
  let previous = -1;
  let text = "";
  for (let attempt = 0; attempt < SETTLE_TRIES; attempt++) {
    text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (text.includes('"usage"') && text.length === previous) break;
    previous = text.length;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return text;
}

async function sumTranscriptUsage(path: string | undefined, settle = true): Promise<Usage> {
  return sumUsage(settle ? await readSettled(path) : readTranscript(path));
}

async function sh(command: string, args: string[]) {
  const { stdout } = await run(command, args, { timeout: SUBPROCESS_TIMEOUT_MS });
  return stdout.trim();
}

async function gitContext(cwd: string) {
  const [branch, toplevel, commonDir] = await Promise.all([
    sh("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
    sh("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => undefined),
    sh("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]).catch(
      () => undefined,
    ),
  ]);
  // A T3 worktree lives outside the project folder; the shared .git dir points back to it.
  const mainRoot = commonDir ? dirname(commonDir) : toplevel;
  return { branch, toplevel, mainRoot, repo: mainRoot ? basename(mainRoot) : undefined };
}

type T3Thread = { threadId: string; title?: string; status?: string };

/** The running thread whose worktree is this session's directory; omitted when T3 can't say. */
async function findT3Thread(
  cwd: string,
  { toplevel, mainRoot }: { toplevel?: string; mainRoot?: string },
) {
  try {
    const list = JSON.parse(
      await sh(T3, ["thread", "list", "--project", mainRoot ?? cwd, "--json"]),
    ) as T3Thread[];
    const running = list.filter((thread) => thread.status === "running");
    const shown = await Promise.all(
      running.map(async (thread) => {
        try {
          const detail = JSON.parse(
            await sh(T3, ["thread", "show", thread.threadId, "--json"]),
          ) as { thread?: { worktreePath?: string | null } };
          return { thread, worktreePath: detail.thread?.worktreePath ?? undefined };
        } catch {
          return undefined;
        }
      }),
    );
    const withTree = shown.find(
      (entry) =>
        entry?.worktreePath !== undefined &&
        (entry.worktreePath === cwd || entry.worktreePath === toplevel),
    );
    // Threads that run in the project folder have no worktree; only an unambiguous one counts.
    const local = shown.filter((entry) => entry && entry.worktreePath === undefined);
    const match = withTree ?? (local.length === 1 ? local[0] : undefined);
    return match && { id: match.thread.threadId, title: match.thread.title };
  } catch {
    return undefined;
  }
}

const USAGE_EVERY_MS = 30_000;
const USAGE_DIR = join(homedir(), ".cache/marshal-factory/usage");

/**
 * A factory session's main usage only lands with turn_stop, and a factory run is one long turn.
 * So after other tool calls, including those inside subagents (the main session waits while a
 * foreground subagent works), the reporter sends a snapshot of the main session and every
 * subagent transcript, at most every 30 s per session. That keeps the job's spend close to real
 * time.
 */
async function usageSnapshot(
  input: HookInput,
  base: { eventId: string; sessionId: string; at: number; transcriptPath?: string },
): Promise<FactoryEvent | undefined> {
  const git = await gitContext(str(input.cwd) ?? process.cwd());
  const onFactoryBranch = Boolean(parseBranch(git.branch));
  if (onFactoryBranch) rememberSessionBranch(base.sessionId, git.branch!);
  if (!onFactoryBranch && !sessionBranch(base.sessionId)) return undefined;
  const stamp = join(USAGE_DIR, base.sessionId.replace(/[^\w-]/g, "_"));
  if (existsSync(stamp) && base.at - statSync(stamp).mtimeMs < USAGE_EVERY_MS) return undefined;
  mkdirSync(USAGE_DIR, { recursive: true });
  writeFileSync(stamp, "");
  const main = mainTranscript(input.transcript_path, base.sessionId);
  const usage = await sumTranscriptUsage(main, false);
  if (usage.model === "unknown") return undefined;
  const agents = main ? await subagentTranscripts(main, base.sessionId, localHost) : [];
  return { ...base, kind: "usage", usage, agents };
}

const SOURCES = new Set(["startup", "resume", "compact"]);

async function toEvent(
  input: HookInput,
  base: { eventId: string; sessionId: string; at: number; transcriptPath?: string },
): Promise<FactoryEvent[] | FactoryEvent | undefined> {
  switch (input.hook_event_name) {
    case "SessionStart": {
      const cwd = str(input.cwd) ?? process.cwd();
      const git = await gitContext(cwd);
      if (parseBranch(git.branch)) rememberSessionBranch(base.sessionId, git.branch!);
      const t3 = await findT3Thread(cwd, git);
      const source = str(input.source);
      return {
        ...base,
        kind: "session_start",
        cwd,
        branch: git.branch,
        repo: git.repo,
        source: source && SOURCES.has(source) ? (source as "startup") : undefined,
        t3ThreadId: t3?.id,
        title: t3?.title ?? str(input.session_title),
        model: str(input.model),
      };
    }
    case "PreToolUse": {
      if (input.tool_name !== "Agent" || !input.tool_use_id) return undefined;
      const tool = input.tool_input ?? {};
      return {
        ...base,
        kind: "agent_start",
        toolUseId: input.tool_use_id,
        subagentType: str(tool.subagent_type) ?? "general-purpose",
        description: str(tool.description) ?? "",
        model: str(tool.model),
        parentAgentId: str(input.agent_id),
      };
    }
    case "PostToolUse": {
      if (input.tool_name === REPORT_STAGE_TOOL) {
        const report = stageReportSchema.safeParse(input.tool_input);
        // The MCP tool refused a report whose screenshots it couldn't read, so it reports nothing either.
        if (!report.success || unreadable(report.data.assessment?.screenshots ?? []).length > 0) return undefined;
        const git = await gitContext(str(input.cwd) ?? process.cwd());
        const jobKey = parseBranch(git.branch)?.key;
        const stage: FactoryEvent = { ...base, kind: "stage", ...report.data, jobKey, branch: git.branch };
        const refs = report.data.assessment?.screenshots ?? [];
        // The images go first, so the panel never shows an assessment whose screenshots haven't arrived.
        return jobKey && refs.length > 0 ? [...screenshotEvents(refs, { jobKey, stageEventId: base.eventId, sessionId: base.sessionId, at: base.at }), stage] : stage;
      }
      const agentId = str(input.tool_response?.agentId);
      if (input.tool_name === "Agent" && input.tool_use_id && agentId) {
        return { ...base, kind: "agent_launched", toolUseId: input.tool_use_id, agentId };
      }
      return usageSnapshot(input, base);
    }
    case "SubagentStop": {
      const agentId = str(input.agent_id);
      if (!agentId) return undefined;
      const usage = await sumTranscriptUsage(input.agent_transcript_path);
      return {
        ...base,
        kind: "agent_stop",
        agentId,
        status: "completed",
        usage,
        model: usage.model === "unknown" ? undefined : usage.model,
      };
    }
    case "Stop":
      return {
        ...base,
        kind: "turn_stop",
        usage: await sumTranscriptUsage(input.transcript_path),
        lastMessage: str(input.last_assistant_message)?.slice(0, LAST_MESSAGE_MAX),
      };
    case "SessionEnd":
      return { ...base, kind: "session_end", reason: str(input.reason) };
    default:
      return undefined;
  }
}

async function main() {
  const raw = readFileSync(0, "utf8");
  const input = JSON.parse(raw) as HookInput;
  const sessionId = str(input.session_id);
  if (!readIngestTarget() || !sessionId) return;

  const eventId = createHash("sha256")
    .update(`${input.hook_event_name}\n${raw}`)
    .digest("hex");
  const event = await toEvent(input, {
    eventId,
    sessionId,
    at: Date.now(),
    // Hooks inside a subagent may name its own transcript; the run records the session's.
    transcriptPath: mainTranscript(str(input.transcript_path), sessionId),
  });
  // Every call flushes, so a backlog left by an ingest outage drains even from hooks that send nothing.
  const flushed = await reportEvents(event ? [event].flat() : [], FLUSH_BUDGET_MS);
  if (flushed?.error && process.env.REPORT_DEBUG) console.error(flushed.error);
}

// A reporting failure must never disturb the session.
await main().catch((error) => {
  if (process.env.REPORT_DEBUG) console.error(error);
});
process.exit(0);
