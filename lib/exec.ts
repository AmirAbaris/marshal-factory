import { execFile } from "node:child_process";

/** A failed run, shaped like promisified execFile's error; a run whose stdin broke also carries `stdinError`. */
export type ExecError = Error & { killed?: boolean; code?: string | number; stdout?: string; stderr?: string; stdinError?: Error };

/** `env` is added to this process's environment; secrets go there, never into argv, which error messages quote. */
export type ExecOptions = { input?: string; cwd?: string; timeoutMs?: number; maxBuffer?: number; env?: Record<string, string> };

/**
 * Runs a command and returns its output. The outcome comes from the process itself: it settles
 * when the process exits, with its exit code and output, or when it never started. With `input`,
 * a stdin error such as EPIPE does not settle anything on its own (the command may have read the
 * input before closing stdin); it is attached to a failure as `stdinError`. Parse the output after
 * awaiting it, never inside a callback where a throw would be lost.
 */
export function exec(command: string, args: string[], { input, cwd, timeoutMs, maxBuffer, env }: ExecOptions = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let stdinError: Error | undefined;
    // An option set to undefined would override execFile's default rather than keep it.
    const options = {
      encoding: "utf8" as const,
      ...(cwd !== undefined && { cwd }),
      ...(timeoutMs !== undefined && { timeout: timeoutMs }),
      ...(maxBuffer !== undefined && { maxBuffer }),
      ...(env !== undefined && { env: { ...process.env, ...env } }),
    };
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr });
      const failure = Object.assign(error, { stdout, stderr }) as ExecError;
      if (stdinError) failure.stdinError = stdinError;
      reject(failure);
    });
    if (input === undefined) return;
    child.stdin?.on("error", (error) => {
      stdinError = error;
    });
    child.stdin?.end(input);
  });
}
