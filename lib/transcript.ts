import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Usage } from "./events";

type Line = {
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
};

export const readTranscript = (path: string | null | undefined) =>
  path && existsSync(path) ? readFileSync(path, "utf8") : "";

/** One API message spans several JSONL lines that repeat its usage, so count each message id once. */
export function sumUsage(transcript: string): Usage {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, model: "unknown" };
  const messages = new Map<string, NonNullable<Line["message"]>>();
  for (const raw of transcript.split("\n")) {
    if (!raw.includes('"usage"')) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const message = line.message;
    if (!message?.usage) continue;
    // Later lines of the same message carry the final output count.
    messages.set(message.id ?? line.requestId ?? raw, message);
  }
  for (const { usage, model } of messages.values()) {
    total.input += usage?.input_tokens ?? 0;
    total.output += usage?.output_tokens ?? 0;
    total.cacheRead += usage?.cache_read_input_tokens ?? 0;
    total.cacheWrite += usage?.cache_creation_input_tokens ?? 0;
    if (model && model !== "<synthetic>") total.model = model;
  }
  return total;
}

export type SubagentTranscript = { agentId: string; toolUseId: string | undefined; usage: Usage };

/**
 * Claude Code writes each subagent's transcript to <session dir>/<session id>/subagents/agent-<id>.jsonl
 * as it runs, next to a .meta.json naming the Agent tool_use that spawned it.
 */
export function subagentTranscripts(transcriptPath: string, sessionId: string): SubagentTranscript[] {
  const dir = join(dirname(transcriptPath), sessionId, "subagents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
    .map((name) => {
      const agentId = name.slice("agent-".length, -".jsonl".length);
      const metaPath = join(dir, `agent-${agentId}.meta.json`);
      const meta = existsSync(metaPath)
        ? (JSON.parse(readFileSync(metaPath, "utf8")) as { toolUseId?: string })
        : {};
      return { agentId, toolUseId: meta.toolUseId, usage: sumUsage(readFileSync(join(dir, name), "utf8")) };
    })
    .filter((s) => s.usage.model !== "unknown");
}

/** Where Claude Code keeps a session's transcript: the cwd with every / and . turned into -. */
export function transcriptPathFor(run: { session_id: string; cwd: string | null; transcript_path: string | null }) {
  if (run.transcript_path) return run.transcript_path;
  if (!run.cwd) return undefined;
  return join(homedir(), ".claude/projects", run.cwd.replace(/[/.]/g, "-"), `${run.session_id}.jsonl`);
}
