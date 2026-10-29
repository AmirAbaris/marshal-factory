import { imageDrift, rebuildText, type BaseImageBuild } from "../lib/machine";
import { builtVersions, pinnedVersions } from "../lib/sandbox";
import { buildSandboxImage, BuildLockedError, type BuildLimits } from "../lib/sandbox-image-build";
import { config } from "./config";
import { sandboxRuntime } from "./sandbox";

// The runner rebuilds the base sandbox image itself once its pins or playbooks drift from the
// stored image, the way onboarding rebuilds a repo's warm image when the base changes. The tick
// starts the build and returns; the build runs beside the queue, one at a time per machine (a
// lock file keeps out a build started by hand too), and the old image stays recorded until the new
// one passed every check. Queued Modal jobs launch from the new image once it lands. A runner with
// no image at all waits for a first build by hand.

/** A failed build for the same pins is tried again after this, not every tick. */
export const RETRY_AFTER_MS = 60 * 60_000;

/** What the base image rebuild reads from this machine; regressions replace any of it. */
export const baseImageRuntime = {
  image: () => sandboxRuntime.image(),
  limits: (): BuildLimits => config.factory.sandbox,
  modalToken: () => sandboxRuntime.modalToken(),
  build: (limits: BuildLimits, log: (message: string) => void, signal: AbortSignal) => buildSandboxImage({ limits, log, signal }),
  now: () => Date.now(),
  log: (event: string, detail: Record<string, unknown>) => sandboxRuntime.log(event, detail),
};

let building: Promise<void> | undefined;
let stopping: AbortController | undefined;
let status: BaseImageBuild | undefined;
let failed: { pins: string; at: number } | undefined;

/** The build in flight or the last one that failed, for the runner log and the Settings page. */
export const baseImageBuild = () => status;

/** Resolves once the build in flight, if any, is done. */
export const baseImageIdle = () => building ?? Promise.resolve();

/** For a stopping runner: ends the build sandbox in flight, which then fails and records nothing. */
export function stopBaseImage() {
  stopping?.abort();
  return baseImageIdle();
}

/** Regressions start each case from no build and no failure. */
export function resetBaseImage() {
  building = undefined;
  status = undefined;
  failed = undefined;
}

/**
 * The tick's look at the base image: starts a rebuild when the stored image differs from the pins,
 * and returns at once. `changed` runs when a build starts, lands or fails; `landed` once a new image is recorded.
 */
export function rebuildBaseImage({ changed = () => {}, landed = () => {} }: { changed?: () => void; landed?: () => void } = {}) {
  if (building) return { building: status?.reason };
  const image = baseImageRuntime.image();
  if (!image) return undefined;
  const limits = baseImageRuntime.limits();
  const pinned = pinnedVersions(limits);
  const drift = imageDrift(builtVersions(image), pinned);
  if (drift.length === 0) {
    status = undefined;
    return undefined;
  }
  if (!baseImageRuntime.modalToken()) return undefined;
  const pins = JSON.stringify(pinned);
  const now = baseImageRuntime.now();
  if (failed?.pins === pins && now - failed.at < RETRY_AFTER_MS) return { failed: status?.state === "failed" ? status.error : undefined };
  const reason = rebuildText(drift);
  status = { state: "building", reason, startedAt: new Date(now).toISOString() };
  baseImageRuntime.log("sandbox-image:started", { reason });
  changed();
  const controller = (stopping = new AbortController());
  building = baseImageRuntime
    .build(limits, (message) => baseImageRuntime.log("sandbox-image:build", { message }), controller.signal)
    .then(
      (built) => {
        status = undefined;
        failed = undefined;
        baseImageRuntime.log("sandbox-image:landed", { imageId: built.imageId, versions: built.versions, ms: baseImageRuntime.now() - now });
        landed();
      },
      (error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        if (error instanceof BuildLockedError) {
          // A build by hand is under way; the next tick looks again once it lands.
          status = undefined;
          baseImageRuntime.log("sandbox-image:locked", { pid: error.pid });
          return;
        }
        status = { state: "failed", reason, error: text.slice(0, 2000), at: new Date(baseImageRuntime.now()).toISOString() };
        failed = { pins, at: baseImageRuntime.now() };
        baseImageRuntime.log("sandbox-image:failed", { reason, error: text, retryAfterMinutes: RETRY_AFTER_MS / 60_000 });
      },
    )
    .finally(() => {
      building = undefined;
      stopping = undefined;
      changed();
    });
  return { started: reason };
}
