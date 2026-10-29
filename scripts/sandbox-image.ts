import { loadLimits } from "../lib/config";
import { buildSandboxImage } from "../lib/sandbox-image-build";

// Builds the image factory sandboxes launch from, and records its id for the runner:
//   bun scripts/sandbox-image.ts
// The runner rebuilds it on its own when a pin or a playbook changes; this is for a first build or
// a rebuild by hand. lib/sandbox-image-build.ts holds the build and the checks it must pass.

const t0 = Date.now();
await buildSandboxImage({
  limits: loadLimits().sandbox,
  log: (message) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${message}`),
});
