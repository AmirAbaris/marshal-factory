import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subagentTranscripts, sumUsage, transcriptPathFor } from "../lib/transcript";

const line = (id: string, input: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 10, cache_creation_input_tokens: 1 } },
  });

const transcript = [line("m1", 5, 1), line("m1", 5, 7), line("m2", 3, 2), "not json", JSON.stringify({ type: "user" })].join("\n");
assert.deepEqual(
  sumUsage(transcript),
  { input: 8, output: 9, cacheRead: 20, cacheWrite: 2, model: "claude-opus-5-5" },
  "each message id counts once, with its last line's output",
);

const dir = mkdtempSync(join(tmpdir(), "transcript-"));
try {
  const main = join(dir, "s1.jsonl");
  writeFileSync(main, transcript);
  const subs = join(dir, "s1", "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(join(subs, "agent-a1.jsonl"), line("x", 100, 50));
  writeFileSync(join(subs, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_1", finished: false }));
  writeFileSync(join(subs, "agent-a2.jsonl"), JSON.stringify({ type: "user" }));
  writeFileSync(join(subs, "agent-a3.jsonl"), line("y", 1, 1));
  writeFileSync(join(subs, "agent-a3.meta.json"), '{"toolUse');
  assert.deepEqual(
    subagentTranscripts(main, "s1").sort((a, b) => a.agentId.localeCompare(b.agentId)),
    [
      { agentId: "a1", toolUseId: "toolu_1", usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 1, model: "claude-opus-5-5" } },
      { agentId: "a3", toolUseId: undefined, usage: { input: 1, output: 1, cacheRead: 10, cacheWrite: 1, model: "claude-opus-5-5" } },
    ],
    "running subagents are found next to the session transcript; ones without usage are skipped, and a half-written meta file does not throw",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

assert.match(
  transcriptPathFor({ session_id: "abc", cwd: "/Users/jan/.t3/worktrees/demo/factory-FAC-5", transcript_path: null })!,
  /\.claude\/projects\/-Users-jan--t3-worktrees-demo-factory-FAC-5\/abc\.jsonl$/,
  "an old run without a recorded path still finds its transcript",
);
console.log("transcript regressions passed");
