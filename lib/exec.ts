import { execFile } from "node:child_process";

/** The error from a run whose stdin broke; the command may still have read its input. */
export type ExecError = Error & { killed?: boolean; code?: string | number; stdinError?: Error };

/**
 * Runs a command with `input` on stdin and returns stdout. The outcome comes from the process
 * itself: it settles when the process exits, with its exit code and output, or when it never
 * started. A stdin error such as EPIPE does not settle anything on its own (the command may
 * have read the input before closing stdin); it is attached to a failure as `stdinError`.
 * Parse the output after awaiting it, never inside a callback where a throw would be lost.
 */
export function runWithInput(command: string, args: string[], input: string, timeoutMs: number) {
  return new Promise<string>((resolve, reject) => {
    let stdinError: Error | undefined;
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (!error) return resolve(stdout);
      const failure = error as ExecError;
      if (stdinError) failure.stdinError = stdinError;
      reject(failure);
    });
    child.stdin?.on("error", (error) => {
      stdinError = error;
    });
    child.stdin?.end(input);
  });
}
