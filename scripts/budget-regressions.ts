import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs hooks/budget.ts as Claude Code would, against a throwaway HOME and two fake checkouts.
const home = mkdtempSync(join(tmpdir(), "budget-"));
const hook = join(import.meta.dirname, "../hooks/budget.ts");
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

write(join(home, ".config/marshal-factory/config.json"), JSON.stringify({ factory: { budgetUsd: 1 } }));
const repo = join(home, "repo");
write(join(repo, ".git/HEAD"), "ref: refs/heads/main\n");
const worktree = join(home, "worktree");
write(join(repo, ".git/worktrees/w/HEAD"), "ref: refs/heads/factory/TST-1\n");
write(join(worktree, ".git"), `gitdir: ${join(repo, ".git/worktrees/w")}\n`);
mkdirSync(join(worktree, "src"), { recursive: true });

function runHook(toolName: string, cwd: string, sessionId = "s-main") {
  const started = Date.now();
  const result = spawnSync("bun", [hook], {
    input: JSON.stringify({ tool_name: toolName, cwd, session_id: sessionId }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr, ms: Date.now() - started };
}
const spend = (usd: number) =>
  write(join(home, ".cache/marshal-factory/spend/TST-1.json"), JSON.stringify({ usd, at: Date.now() }));

try {
  assert.equal(runHook("Bash", join(worktree, "src")).code, 0, "no cached spend yet means no block");
  spend(0.4);
  assert.equal(runHook("Bash", worktree).code, 0, "under the cap");
  spend(1.2);
  const blocked = runHook("Bash", join(worktree, "src"));
  assert.equal(blocked.code, 2, "over the cap blocks the tool call");
  assert.match(blocked.stderr, /report_stage with stage "failed"/);
  assert.equal(runHook("mcp__factory-report__report_stage", worktree).code, 0, "report_stage stays allowed");
  write(join(home, "folder/.git/HEAD"), "ref: refs/heads/factory/TST-1\n");
  assert.equal(runHook("Bash", join(home, "folder")).code, 2, "a plain checkout on a factory branch is capped too");

  assert.equal(runHook("Bash", repo, "s-factory").code, 0, "an unknown session on a plain branch passes");
  write(join(home, ".cache/marshal-factory/sessions/s-factory"), "TST-1");
  assert.equal(
    runHook("Bash", repo, "s-factory").code,
    2,
    "a subagent in its own non-factory worktree is capped through its session",
  );

  const plain = runHook("Bash", repo);
  assert.equal(plain.code, 0, "a session that is not on a factory branch is never blocked");
  assert.ok(plain.ms < 1000, `the hook stays fast (${plain.ms} ms)`);
  console.log(`budget regressions passed (${blocked.ms} ms blocked, ${plain.ms} ms pass-through)`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
