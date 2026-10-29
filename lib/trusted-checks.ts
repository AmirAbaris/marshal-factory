import type { PlannedCheck } from "./evidence";
import { matchesAny } from "./globs";
import { CHECKS, RECIPE_PATH } from "./recipe";

// What a PR must not change if its own checks are to count as proof. The recorded recipe's commands
// are trusted (lib/evidence.ts `headEvidence` compares them), but a command is only as honest as the
// files it runs: the recipe itself, the package.json scripts it calls and the CI workflows. A PR
// that edits any of them hands over, whatever its evidence says.

const WORKFLOWS = [".github/workflows/**"];
const PACKAGE_JSON = "package.json";

export type Scripts = Readonly<Record<string, string>>;

/** The string-valued `scripts` of a package.json text; null when it is missing or not JSON. */
export function scriptsOf(packageJson: string | null): Scripts | null {
  if (packageJson === null) return null;
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return null;
  }
}

const RUNS_SCRIPT = /\b(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?([\w][\w:.-]*)/g;

/**
 * The scripts the commands run in any of these versions, following one script calling another. A
 * script only the head has counts too, so adding one is as visible as changing one.
 */
export function usedScripts(commands: readonly string[], ...versions: readonly Scripts[]): string[] {
  const used = new Set<string>();
  const queue = [...commands];
  for (let command = queue.pop(); command !== undefined; command = queue.pop()) {
    for (const [, name] of command.matchAll(RUNS_SCRIPT)) {
      if (!name || used.has(name)) continue;
      const bodies = versions.flatMap((scripts) => (name in scripts ? [scripts[name]!] : []));
      if (bodies.length === 0) continue;
      used.add(name);
      queue.push(...bodies);
    }
  }
  return [...used].sort();
}

/**
 * Why this PR edits what the factory trusts, one reason each; empty when it doesn't. `required` is
 * the recorded recipe's checks, null for a repo whose checks are its package.json scripts. `base`
 * and `head` are the two versions of package.json's scripts; null when one couldn't be read.
 */
export function trustedEdits({ files, required, base, head }: { files: readonly string[]; required: readonly PlannedCheck[] | null; base: Scripts | null; head: Scripts | null }): string[] {
  const reasons: string[] = [];
  if (files.includes(RECIPE_PATH)) reasons.push(`The pull request edits the recipe the factory trusts: ${RECIPE_PATH}.`);
  const workflows = files.filter((file) => matchesAny(file, WORKFLOWS));
  if (workflows.length > 0) reasons.push(`The pull request edits CI workflows (${workflows.slice(0, 3).join(", ")}${workflows.length > 3 ? ` and ${workflows.length - 3} more` : ""}).`);
  if (files.includes(PACKAGE_JSON)) {
    if (!base || !head) reasons.push("The pull request edits package.json, and its scripts couldn't be compared with the base branch's.");
    else {
      const commands = required ? required.map((c) => c.command) : CHECKS.map((name) => `bun run ${name}`);
      const changed = usedScripts(commands, base, head).filter((name) => base[name] !== head[name]);
      if (changed.length > 0) reasons.push(`The pull request edits the check scripts the factory trusts: ${changed.map((name) => `package.json scripts.${name}`).join(", ")}.`);
    }
  }
  return reasons;
}
