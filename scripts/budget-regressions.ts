import "./test-guard";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { factorySchema } from "../lib/config";
import { wiredRoots, withHooks } from "../lib/target-wiring";

// There is no budget cap. Repos wired before it was removed still run hooks/budget.ts, which must allow everything.
const home = mkdtempSync(join(tmpdir(), "budget-"));
const hook = join(import.meta.dirname, "../hooks/budget.ts");
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

write(join(home, ".config/marshal-factory/config.json"), JSON.stringify({ factory: { budgetUsd: 1 } }));
const worktree = join(home, "worktree");
write(join(worktree, ".git/HEAD"), "ref: refs/heads/factory/TST-1\n");
// What the old reporter cached for the old hook: far over the old config's cap.
write(join(home, ".cache/marshal-factory/spend/factory_TST-1.json"), JSON.stringify({ usd: 50, at: Date.now() }));

function runHook(toolName: string) {
  const result = spawnSync("bun", [hook], {
    input: JSON.stringify({ tool_name: toolName, cwd: worktree, session_id: "s-main" }),
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return { code: result.status, stderr: result.stderr };
}

try {
  for (const tool of ["Bash", "Edit", "Agent", "mcp__factory-report__report_stage"]) {
    const result = runHook(tool);
    assert.equal(result.code, 0, `${tool} is allowed however much the attempt spent`);
    assert.equal(result.stderr, "", `${tool} gets no message`);
  }

  assert.equal(factorySchema.parse({ budgetUsd: 5 }).teamKey, "FAC", "a config that still sets budgetUsd parses");
  assert.ok(!("budgetUsd" in factorySchema.parse({ budgetUsd: 5 })), "and the key is ignored");

  const root = "/opt/marshal-factory";
  const old = {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: "command", command: `bun "${root}/hooks/budget.ts"`, timeout: 10 }] },
        { matcher: "Agent", hooks: [{ type: "command", command: `bun "${root}/hooks/report.ts"`, async: true, timeout: 20 }] },
        { matcher: "Bash", hooks: [{ type: "command", command: "echo theirs" }] },
      ],
    },
  };
  const rewired = JSON.stringify(withHooks(old, root));
  assert.ok(!rewired.includes("hooks/budget.ts"), "rewiring an old repo drops the budget hook");
  assert.ok(rewired.includes("echo theirs"), "and keeps the repo's own hooks");
  assert.ok(!JSON.stringify(withHooks({}, root)).includes("budget"), "new wiring has no budget hook");
  assert.deepEqual(wiredRoots(JSON.stringify(old)), [root], "an old wiring still names its factory checkout");
  console.log("budget regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
