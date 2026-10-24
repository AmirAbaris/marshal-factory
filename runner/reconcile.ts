/** Runs a step with its error as the result, so one failing step never skips the ones after it. */
export const isolated = <T>(step: () => Promise<T>) =>
  step().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));

/**
 * The startup pass: everything a missed webhook could have changed, plus the timer's checks.
 * Cleanup only frees disk, so a GitHub or git failure there must not keep queued jobs waiting.
 */
export async function reconcile<T extends object, L>({
  tick,
  cleanup,
  launch,
}: {
  tick: () => Promise<T>;
  cleanup: () => Promise<unknown>;
  launch: () => Promise<L>;
}) {
  return { ...(await tick()), cleaned: await isolated(cleanup), launched: await launch() };
}
