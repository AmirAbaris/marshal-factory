import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SANDBOX_IMAGE_PATH, type SandboxLimits } from "./config";
import type { SandboxReadiness } from "./machine";

// Fixed paths inside a job's sandbox. The image puts the factory's hook and MCP bundles under
// FACTORY_ROOT; each launch clones the job's repo into REPO_DIR.

export const FACTORY_ROOT = "/opt/marshal-factory";
export const REPO_DIR = "/work/repo";
export const SANDBOX_HOME = "/root";
export const GITHUB_TOKEN_PATH = `${SANDBOX_HOME}/.config/marshal-factory/github-token`;
export const INGEST_CONFIG_PATH = `${SANDBOX_HOME}/.config/marshal-factory/config.json`;
export const T3_USERDATA = `${SANDBOX_HOME}/.t3/userdata`;
export const CODEX_HOME = `${SANDBOX_HOME}/.codex`;
export const T3_PORT = 3773;

export const sandboxImageSchema = z.object({
  imageId: z.string().min(1),
  t3Version: z.string(),
  factoryCommit: z.string(),
  builtAt: z.string(),
});
export type SandboxImage = z.infer<typeof sandboxImageSchema>;

/** The stored image, or null when none was built or it is unreadable. */
export function readSandboxImage(path = SANDBOX_IMAGE_PATH): SandboxImage | null {
  if (!existsSync(path)) return null;
  try {
    return sandboxImageSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

/** Why this image cannot launch jobs under these limits, or undefined when it can. */
export function imageProblem(image: SandboxImage | null, limits: Pick<SandboxLimits, "t3Version">) {
  if (!image) return "no sandbox image is built; run bun scripts/sandbox-image.ts";
  if (image.t3Version !== limits.t3Version) return `the sandbox image has T3 ${image.t3Version} but the config pins ${limits.t3Version}; run bun scripts/sandbox-image.ts`;
  return undefined;
}

export const slotAuthPath = (slot: string) => join(slot, "auth.json");

/** Booleans and a count only: whether this runner could launch on Modal, never the credentials themselves. */
export function sandboxReadiness(limits: Pick<SandboxLimits, "codexSlots">, env: NodeJS.ProcessEnv = process.env): SandboxReadiness {
  return {
    modal: Boolean(env.MODAL_TOKEN_ID) || existsSync(join(homedir(), ".modal.toml")),
    claude: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
    codexSlots: limits.codexSlots.filter((slot) => existsSync(slotAuthPath(slot))).length,
    image: existsSync(SANDBOX_IMAGE_PATH),
  };
}
