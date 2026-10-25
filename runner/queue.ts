/**
 * Races `step` against a hard timeout. A step that loses keeps running; its later rejection goes to
 * `onLateError` instead of being left unhandled.
 */
export async function withTimeout<T>(step: () => Promise<T>, timeoutMs: number, onLateError: (error: unknown) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abandoned = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abandoned = true;
      reject(new Error(`step timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const running = Promise.resolve().then(step);
  running.catch((error: unknown) => {
    if (abandoned) onLateError(error);
  });
  try {
    return await Promise.race([running, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The runner's serial queue: one step at a time, so intents, the timer and the reconcile never
 * touch the same issue at once. Every step runs with a hard timeout and caught errors, so no single
 * promise can stall the queue; a step that times out is logged and the queue moves on.
 */
export function serialQueue(log: (event: string, detail: Record<string, unknown>) => void, timeoutMs = 300_000) {
  let chain: Promise<unknown> = Promise.resolve();

  function serial<T>(name: string, step: () => Promise<T>): Promise<T | undefined> {
    const next = chain.then(async () => {
      const started = Date.now();
      try {
        const result = await withTimeout(step, timeoutMs, (error) => log(`${name}:late-error`, { error: message(error) }));
        log(name, { ms: Date.now() - started, result });
        return result;
      } catch (error) {
        log(`${name}:error`, { ms: Date.now() - started, error: message(error) });
        return undefined;
      }
    });
    chain = next;
    return next;
  }

  return { serial, idle: () => chain };
}

/**
 * Runs `step` at most once per `everyMs`. The clock only advances when a run succeeds, so a failed
 * run is retried at the next chance, and a run still going (perhaps abandoned by a queue timeout)
 * is never started a second time.
 */
export function everyAtMost<T>(everyMs: number, step: () => Promise<T>, now = Date.now) {
  let last = now();
  let running = false;
  return async (): Promise<T | { error: string } | undefined> => {
    if (running || now() - last < everyMs) return undefined;
    running = true;
    try {
      const result = await step();
      last = now();
      return result;
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    } finally {
      running = false;
    }
  };
}
