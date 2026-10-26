import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { exec, type ExecOptions } from "./exec";
import { forbidInTest } from "./test-mode";

/**
 * The machine a job's thread, worktree and transcripts live on. `run` settles like promisified
 * execFile: it resolves with the output of a zero exit and rejects with an ExecError.
 */
export type JobHost = {
  /** The T3 CLI on this host. */
  readonly t3: string;
  run(command: string, args: string[], options?: ExecOptions): Promise<{ stdout: string; stderr: string }>;
  /** The file's text, or null when it does not exist. */
  readFile(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number>;
  remove(path: string): Promise<void>;
};

// The LaunchAgent sets T3CODE_CLI_PATH; otherwise t3 must be on PATH.
const localT3 = () => process.env.T3CODE_CLI_PATH ?? "t3";
const GUARDED_T3 = new Set(["start", "show", "send"]);

export const localHost: JobHost = {
  get t3() {
    return localT3();
  },
  async run(command, args, options) {
    if (command === localT3() && args[0] === "thread" && GUARDED_T3.has(args[1]!)) forbidInTest(`t3 thread ${args[1]}`);
    return exec(command, args, options);
  },
  async readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  exists: async (path) => existsSync(path),
  list: async (dir) => readdirSync(dir),
  mtimeMs: async (path) => statSync(path).mtimeMs,
  remove: async (path) => rmSync(path, { recursive: true, force: true }),
};

export type HostedJob = { key: string };

/** Resolves the host per job; a job that runs elsewhere gets its own host here. Regressions swap in a fake. */
export const hosts: { forJob: (job: HostedJob) => JobHost } = { forJob: () => localHost };
