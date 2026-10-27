import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Reads the branch from .git without spawning git; worktrees keep HEAD behind a gitdir pointer. */
export function currentBranch(cwd: string) {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      const pointer = statSync(dotGit).isDirectory()
        ? undefined
        : readFileSync(dotGit, "utf8").match(/^gitdir: (.+)$/m)?.[1];
      const gitDir = pointer ? resolve(dir, pointer.trim()) : dotGit;
      return readFileSync(join(gitDir, "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1];
    }
    if (dirname(dir) === dir) return undefined;
  }
}
