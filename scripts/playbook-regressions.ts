import "./test-guard";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { JobHost } from "../lib/host";

const { factorySchema } = await import("../lib/config");
const { factoryPlaybook, jobExecution, REPO_PLAYBOOK, withPlaybook } = await import("../lib/playbook");
const { imageProblem, installPlaybooks, pinnedVersions, playbooksVersion, SANDBOX_PLAYBOOKS } = await import("../lib/sandbox");
const { conflictMessage } = await import("../lib/conflicts");
const { resumeMessage } = await import("../lib/resume");
const { nudgeMessage } = await import("../lib/watchdog");

const root = resolve(import.meta.dirname, "..");
const pins = factorySchema.parse({}).sandbox;

// Where the playbook is: the image's copy in a sandbox, the runner's checkout on its own machine.
assert.equal(factoryPlaybook("modal"), "/opt/marshal-factory/playbooks/factory.md");
assert.equal(factoryPlaybook("local"), join(root, "playbooks/factory.md"));
assert.ok(existsSync(factoryPlaybook("local")), "the local path is a file the runner's thread can open");
const none = { sandbox_id: null, sandbox_snapshot: null };
assert.equal(jobExecution({ execution: "modal", ...none }), "modal");
assert.equal(jobExecution({ execution: null, sandbox_id: null, sandbox_snapshot: "im-snap" }), "modal", "a hibernated job without a recorded execution ran in a sandbox");
assert.equal(jobExecution({ execution: null, ...none }), "local");

// The launch message names the host's path, and a repo copy only adds notes.
const calls: string[][] = [];
const host = (hasCopy: boolean): JobHost =>
  ({
    t3: "t3",
    run: async (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (!hasCopy) throw Object.assign(new Error("exit 128"), { code: 128 });
      return { stdout: "", stderr: "" };
    },
  }) as unknown as JobHost;
for (const execution of ["modal", "local"] as const) {
  const path = factoryPlaybook(execution);
  calls.length = 0;
  const bare = await withPlaybook("Work FAC-1: Title", execution, host(false), "/work/repo");
  assert.ok(bare.startsWith("Work FAC-1: Title\n\n## Factory playbook\n"), `${execution}: the section follows the message`);
  assert.ok(bare.includes(`The factory playbook is ${path}.`), `${execution}: names ${path}`);
  assert.ok(!bare.includes(REPO_PLAYBOOK), `${execution}: a repo without a copy hears nothing about one`);
  assert.deepEqual(calls, [["git", "-C", "/work/repo", "cat-file", "-e", `origin/main:${REPO_PLAYBOOK}`]], `${execution}: the copy is looked up on main in the job's checkout`);
  const withCopy = await withPlaybook("Work FAC-1: Title", execution, host(true), "/work/repo");
  assert.ok(withCopy.includes(`This repository also has ${REPO_PLAYBOOK}. The factory playbook at ${path} is authoritative`), `${execution}: the factory playbook wins over a repo copy`);
  assert.ok(withCopy.includes("only for notes specific to this repository"));
}

// Follow-ups name the same path the launch did.
for (const path of [factoryPlaybook("modal"), factoryPlaybook("local")]) {
  for (const [name, text] of [
    ["conflict", conflictMessage("FAC-1", "https://github.com/o/r/pull/1", path)],
    ["resume", resumeMessage("FAC-1", "Which one?", "The first.", path)],
    ["nudge", nudgeMessage("FAC-1", "implementing", 30, path)],
  ] as const) {
    assert.ok(text.includes(`factory playbook (${path})`), `${name} names ${path}`);
    assert.ok(!text.includes(REPO_PLAYBOOK), `${name} does not point at a repo copy`);
  }
}

// The image build copies both playbooks and records the hash of what the image holds.
const files = new Map<string, string>();
const fs = { writeText: async (text: string, path: string) => void files.set(path, text), readText: async (path: string) => files.get(path)! };
const version = await installPlaybooks(fs);
assert.deepEqual([...files.keys()], [`${SANDBOX_PLAYBOOKS}/factory.md`, `${SANDBOX_PLAYBOOKS}/onboarding.md`]);
for (const file of ["factory.md", "onboarding.md"]) assert.equal(files.get(`${SANDBOX_PLAYBOOKS}/${file}`), readFileSync(join(root, "playbooks", file), "utf8"), `${file} is copied as is`);
assert.match(version, /^[0-9a-f]{12}$/);
assert.equal(version, pinnedVersions(pins).playbooks, "the image's playbooks match the runner's pin");
const garbled = { ...fs, readText: async (path: string) => `${files.get(path)!} ` };
assert.notEqual(await installPlaybooks(garbled), version, "an image that holds other text records another version");

// A changed playbook makes an image built before it outdated.
const image = { imageId: "im-test", t3Version: pins.t3Version, versions: pinnedVersions(pins), factoryCommit: "abc", builtAt: "now" };
assert.equal(imageProblem(image, pins), undefined);
const edited = playbooksVersion((file) => `${readFileSync(join(root, "playbooks", file), "utf8")}\nOne more rule.`);
assert.notEqual(edited, version, "an edit changes the version");
const older = { ...image, versions: { ...image.versions, playbooks: edited } };
assert.equal(imageProblem(older, pins), `Rebuild the sandbox image: Factory playbooks ${edited} → ${version}; the runner rebuilds it on its tick, or run bun scripts/sandbox-image.ts`);
assert.match(imageProblem({ ...image, versions: { ...image.versions, playbooks: undefined } }, pins)!, /^Rebuild the sandbox image: Factory playbooks missing → /, "an image from before the playbooks shipped is outdated");

// What the playbook points at still resolves from outside the repo.
const playbook = readFileSync(join(root, "playbooks/factory.md"), "utf8");
assert.match(playbook, /^---\nextends: bug-fix, feature, opening-a-pr, babysit\n/, "it extends PStack's bundled playbooks, which the image and the runner have");
assert.ok(playbook.includes("`factory-verify`") && playbook.includes("hooks/verify.ts"), "it names factory-verify by PATH and by the factory root, not by a repo path");
assert.ok(!playbook.includes(REPO_PLAYBOOK), "it never names a repo copy as its own location");

console.log("playbook regressions passed");
process.exit(0);
