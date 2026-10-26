import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { CONFIG_PATH, SANDBOX_IMAGE_PATH, type SandboxLimits } from "./config";
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
export const CODEX_AUTH = `${CODEX_HOME}/auth.json`;
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

/**
 * Login slots whose login failed in a sandbox, kept next to the config. An entry holds while the
 * slot's auth.json keeps the modification time it had then; logging in again rewrites the file and
 * clears it. No credentials are stored, only the slot path, the reason and times.
 */
export const SLOT_HEALTH_PATH = join(dirname(CONFIG_PATH), "codex-slots.json");

export const slotHealthSchema = z.array(
  z.object({ slot: z.string(), status: z.literal("unusable"), reason: z.string(), at: z.string(), authMtimeMs: z.number() }),
);
export type SlotHealth = z.infer<typeof slotHealthSchema>;

export function readSlotHealth(path = SLOT_HEALTH_PATH): SlotHealth {
  if (!existsSync(path)) return [];
  try {
    return slotHealthSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return [];
  }
}

/** The auth.json modification time, or null when the slot has no login. */
export function slotAuthMtime(slot: string) {
  try {
    return statSync(slotAuthPath(slot)).mtimeMs;
  } catch {
    return null;
  }
}

export const slotUnusable = (health: SlotHealth, slot: string, authMtimeMs: number | null) =>
  health.some((h) => h.slot === slot && h.authMtimeMs === authMtimeMs);

/** Booleans and counts only: whether this runner could launch on Modal, never the credentials themselves. */
export function sandboxReadiness(
  limits: Pick<SandboxLimits, "codexSlots">,
  env: NodeJS.ProcessEnv = process.env,
  health = readSlotHealth(),
): SandboxReadiness {
  const loggedIn = limits.codexSlots.filter((slot) => existsSync(slotAuthPath(slot)));
  const unusable = loggedIn.filter((slot) => slotUnusable(health, slot, slotAuthMtime(slot))).length;
  return {
    modal: Boolean(env.MODAL_TOKEN_ID) || existsSync(join(homedir(), ".modal.toml")),
    claude: Boolean(env.CLAUDE_CODE_OAUTH_TOKEN),
    codexSlots: loggedIn.length - unusable,
    codexSlotsUnusable: unusable,
    image: existsSync(SANDBOX_IMAGE_PATH),
  };
}
