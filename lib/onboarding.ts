import { z } from "zod";
import { imageDrift, imageVersionsSchema, rebuildText, type ImageVersions } from "./machine";
import { CHECKS, missingEnv, recipeSchema, type Recipe } from "./recipe";

// Onboarding a repository: the factory gets a setup recipe for it (the repo's committed one, or an
// agent writes one and opens a PR with it), asks for the secrets the recipe names, and builds a
// warm per-repo Modal image from it, so the repo's jobs start with everything installed.
//
//   analyzing    reading the committed recipe, or an agent writing one in an onboarding sandbox
//   needs_input  the recipe names required env vars no secret is saved for yet
//   building     the first warm image is building
//   ready        the warm image serves the repo's Modal jobs
//   rebuilding   a newer warm image is building; the old one serves meanwhile
//   failed       the last step failed; the reason is on the row, an image built before still serves
//
// A repo whose state is null predates onboarding and launches from the base image, as before.

export const ONBOARDING_STATES = ["analyzing", "needs_input", "building", "ready", "rebuilding", "failed"] as const;
export type OnboardingState = (typeof ONBOARDING_STATES)[number];

export const STATE_LABELS: Record<OnboardingState, string> = {
  analyzing: "Analyzing",
  needs_input: "Needs input",
  building: "Building",
  ready: "Ready",
  rebuilding: "Rebuilding",
  failed: "Failed",
};

export const checkResultSchema = z.object({ name: z.enum(CHECKS), command: z.string(), ok: z.boolean(), note: z.string().optional() });
export type CheckResult = z.infer<typeof checkResultSchema>;

/** The base image a warm image was built on, by what the panel can see of it: its versions and build time. */
const baseSchema = z.object({ versions: imageVersionsSchema, builtAt: z.string() });
export type BaseImage = z.infer<typeof baseSchema>;

export const repoImageSchema = z.object({
  id: z.string(),
  builtAt: z.string(),
  /** origin/main when it was built. */
  commit: z.string(),
  base: baseSchema,
  recipeHash: z.string(),
  /** Of the files the recipe's warmKey matched at that commit. */
  warmKeyHash: z.string(),
});
export type RepoImage = z.infer<typeof repoImageSchema>;

/** What a runner has going for the repo: an agent writing the recipe, or a warm image build. */
export const runSchema = z.object({
  kind: z.enum(["agent", "build"]),
  machine: z.string(),
  sandboxId: z.string(),
  startedAt: z.string(),
  /** The Codex login slot an agent run holds. */
  slot: z.string().optional(),
  threadId: z.string().optional(),
  tokenAt: z.string().optional(),
  /** A build of a committed recipe also runs its checks. */
  checks: z.boolean().optional(),
  /** Why a build runs: the rebuild it took on. */
  reason: z.string().optional(),
});
export type OnboardingRun = z.infer<typeof runSchema>;

export const onboardingDetailSchema = z.object({
  recipe: recipeSchema.optional(),
  /** Where the recipe came from: the repo's main, or an agent's PR not merged yet. */
  recipeSource: z.enum(["committed", "agent"]).optional(),
  recipePr: z.string().optional(),
  summary: z.string().optional(),
  checks: z.array(checkResultSchema).optional(),
  missingSecrets: z.array(z.string()).optional(),
  /** Names only: which env vars the repo's Modal secret holds. */
  secretsSet: z.array(z.string()).optional(),
  failure: z.object({ reason: z.string(), log: z.string().optional(), at: z.string() }).optional(),
  image: repoImageSchema.optional(),
  run: runSchema.optional(),
  /** Why another build is wanted once the current one finishes. */
  rebuild: z.object({ reason: z.string(), at: z.string() }).optional(),
});
export type OnboardingDetail = z.infer<typeof onboardingDetailSchema>;

export const parseDetail = (value: unknown): OnboardingDetail => onboardingDetailSchema.safeParse(value ?? {}).data ?? {};

/** The Modal secret a repo's sandboxes get, named from the repo within Modal's 64 characters. */
export const modalSecretName = (repo: string) =>
  `mf-repo-${repo.replace("/", "-")}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/-$/, "")
    .slice(0, 64);

/** After a recipe is known: secrets first, then the image. */
export function afterRecipe(recipe: Recipe, detail: OnboardingDetail): { state: OnboardingState; missingSecrets: string[] } {
  const missing = missingEnv(recipe, detail.secretsSet ?? []);
  if (missing.length > 0) return { state: "needs_input", missingSecrets: missing };
  return { state: detail.image ? "rebuilding" : "building", missingSecrets: [] };
}

/** Why the warm image no longer fits the base image jobs must launch from, or undefined when it does. */
export function imageOutdated(image: RepoImage, base: BaseImage | null) {
  if (!base) return undefined;
  const drift = imageDrift(image.base.versions, base.versions as Required<ImageVersions>);
  if (drift.length > 0) return `its base image is outdated: ${rebuildText(drift)}`;
  if (image.base.builtAt !== base.builtAt) return "the base image was rebuilt since";
  return undefined;
}

export type RepoImageChoice =
  | { kind: "warm"; imageId: string }
  | { kind: "base"; outdated?: string }
  | { kind: "blocked"; reason: string };

type OnboardingRow = { repo: string; onboarding_state: OnboardingState | null; onboarding_detail: unknown };

/**
 * The image a repo's Modal job launches from: its warm image while it fits the base, else the base
 * image. A repo still onboarding without any warm image cannot launch on Modal yet.
 */
export function repoImage(row: OnboardingRow | undefined, base: BaseImage | null): RepoImageChoice {
  if (!row?.onboarding_state) return { kind: "base" };
  const { image } = parseDetail(row.onboarding_detail);
  if (image) {
    const outdated = imageOutdated(image, base);
    return outdated ? { kind: "base", outdated } : { kind: "warm", imageId: image.id };
  }
  switch (row.onboarding_state) {
    case "ready":
    case "rebuilding":
      return { kind: "base" };
    case "analyzing":
    case "needs_input":
    case "building":
    case "failed":
      return { kind: "blocked", reason: `${row.repo} is not onboarded yet (${STATE_LABELS[row.onboarding_state].toLowerCase()})` };
    default: {
      const never: never = row.onboarding_state;
      throw new Error(`unknown onboarding state ${String(never)}`);
    }
  }
}

/** One line on where onboarding stands, for the Repositories list. */
export function stateLine(state: OnboardingState, detail: OnboardingDetail) {
  switch (state) {
    case "analyzing":
      return detail.run?.kind === "agent" ? "An agent is writing the setup recipe" : "Looking for a setup recipe";
    case "needs_input": {
      const missing = detail.missingSecrets ?? [];
      return `Needs ${missing.length === 1 ? "a secret" : `${missing.length} secrets`}: ${missing.join(", ")}`;
    }
    case "building":
      return "Building the warm image";
    case "ready":
      return detail.image ? "Warm image ready" : "Ready";
    case "rebuilding":
    {
      const reason = detail.run?.reason ?? detail.rebuild?.reason;
      return `Rebuilding${reason ? ` because ${reason}` : ""}; the current image serves meanwhile`;
    }
    case "failed":
      return detail.failure?.reason ?? "Onboarding failed";
    default: {
      const never: never = state;
      throw new Error(`unknown onboarding state ${String(never)}`);
    }
  }
}
