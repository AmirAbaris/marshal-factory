import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
  /** Writes the file, creating its parent directories. */
  writeFile(path: string, text: string): Promise<void>;
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
  async writeFile(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  exists: async (path) => existsSync(path),
  list: async (dir) => readdirSync(dir),
  mtimeMs: async (path) => statSync(path).mtimeMs,
  remove: async (path) => rmSync(path, { recursive: true, force: true }),
};

/** Thrown by a host whose machine no longer exists, such as a terminated sandbox: its threads are gone. */
export class HostGoneError extends Error {}

export type HostedJob = { key: string; sandbox_id: string | null };

/**
 * Resolves the host per job: a job with a sandbox runs there, any other on this machine. The runner
 * registers `sandbox`, so hooks that import this module never load the Modal SDK. Regressions swap in fakes.
 */
export const hosts: { forJob: (job: HostedJob) => JobHost; sandbox: (sandboxId: string) => JobHost } = {
  forJob: (job) => (job.sandbox_id ? hosts.sandbox(job.sandbox_id) : localHost),
  sandbox: (sandboxId) => {
    throw new Error(`no sandbox host is registered for ${sandboxId}`);
  },
};
