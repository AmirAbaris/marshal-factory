import "./test-guard";
import assert from "node:assert/strict";
import { attemptBranch, isJobKey, jobKey, parseBranch } from "../lib/factory";
import { mcpIdentity } from "../lib/report-identity";

// One parser for every attempt branch: the Linear branches already out there and the generic format.
const branches: [string | undefined, ReturnType<typeof parseBranch>][] = [
  ["factory/FAC-59", { key: "FAC-59", attempt: 1 }],
  ["factory/FAC-10-a2", { key: "FAC-10", attempt: 2 }],
  ["factory/FAC-10-a12", { key: "FAC-10", attempt: 12 }],
  ["factory/ENG2-7", { key: "ENG2-7", attempt: 1 }],
  ["factory/fac-5", { key: "fac-5", attempt: 1 }],
  ["factory/GH-marshal-factory-42", { key: "GH-marshal-factory-42", attempt: 1 }],
  ["factory/GH-marshal-factory-42-a3", { key: "GH-marshal-factory-42", attempt: 3 }],
  ["factory/GH-a-1-a2", { key: "GH-a-1", attempt: 2 }],
  ["factory/SL-c0123-1730000000-a2", { key: "SL-c0123-1730000000", attempt: 2 }],
  ["factory/onboarding", undefined],
  ["factory/FAC", undefined],
  ["factory/FAC-", undefined],
  ["factory/FAC-5-a", undefined],
  ["factory/FAC-5-A2", undefined],
  ["factory/GH-Marshal-42", undefined],
  ["factory/GH--42", undefined],
  ["factory/FAC-5/x", undefined],
  ["FAC-5", undefined],
  ["feature/FAC-5", undefined],
  ["worktree-agent-abc", undefined],
  [`factory/GH-${"x".repeat(80)}-1`, undefined],
  ["", undefined],
  [undefined, undefined],
];
for (const [branch, want] of branches) assert.deepEqual(parseBranch(branch), want, `parseBranch(${branch})`);

// Every key a source makes round-trips through its attempt branches.
const keys = ["FAC-1", "FAC-123", jobKey("FAC", 7), jobKey("GH", 42, "ski043/Factory Demo"), jobKey("SL", "1730000000", "C0123")];
assert.deepEqual(keys.slice(2), ["FAC-7", "GH-ski043-factory-demo-42", "SL-c0123-1730000000"]);
for (const key of keys) {
  assert.ok(isJobKey(key), key);
  for (const attempt of [1, 2, 10]) assert.deepEqual(parseBranch(attemptBranch(key, attempt)), { key, attempt }, `${key} attempt ${attempt}`);
}
assert.equal(attemptBranch("FAC-5", 1), "factory/FAC-5", "a first attempt has no suffix, as before");
assert.throws(() => jobKey("gh", 1), /cannot make a job key/, "a prefix is uppercase");
assert.throws(() => jobKey("GH", "x"), /cannot make a job key/, "a key ends in its number");
assert.throws(() => jobKey("GH", 1, "y".repeat(80)), /cannot make a job key/, "a key stays short enough for a branch");
for (const bad of ["FAC-5-a2", "GH-x", "GH-X-1", "FAC 5", "factory/FAC-5", "FAC-5."]) assert.equal(isJobKey(bad), false, bad);

// The report identity reads a generic key from its branch or env like a Linear one.
assert.deepEqual(mcpIdentity({}, "/w", () => "factory/GH-demo-9-a2"), { jobKey: "GH-demo-9", branch: "factory/GH-demo-9-a2", sessionId: "mcp:factory/GH-demo-9-a2" });
assert.deepEqual(mcpIdentity({ FACTORY_JOB_KEY: "GH-demo-9", FACTORY_ATTEMPT: "3" }, "/w"), { jobKey: "GH-demo-9", branch: "factory/GH-demo-9-a3", sessionId: "mcp:factory/GH-demo-9-a3" });
assert.equal(mcpIdentity({}, "/w", () => "factory/onboarding"), undefined);

console.log("job key regressions passed");
