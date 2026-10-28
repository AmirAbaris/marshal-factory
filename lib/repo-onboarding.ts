import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "@/db/schema";
import { intents, repoSettings, type IntentKind } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { Installable } from "@/lib/github/installation";
import { scrubbed } from "@/lib/modal-secrets";
import { afterRecipe, modalSecretName, parseDetail, type OnboardingState } from "@/lib/onboarding";
import { REPO_NAME, repoName } from "@/lib/repo-name";
import { REPOSITORY_GROUP, type Registry } from "@/lib/repositories";
import { missingEnv } from "@/lib/recipe";
import type { SettingsOutcome } from "@/lib/settings";
import type { LabelGroupSpec } from "@/lib/sources/types";

// The Repositories page's onboarding actions, owner only: add a repo the GitHub App reaches, save
// the secrets its recipe names, retry onboarding, rebuild its warm image. Each hands the runner an
// intent; secret values go straight to Modal and nowhere else.

type Db = NodePgDatabase<typeof schema>;

const FORBIDDEN = { ok: false, status: 403, message: "Only the factory owner can change repositories." } as const;
const invalid = (message: string) => ({ ok: false, status: 400, message }) as const;
const failed = (what: string, error: unknown) => ({ ok: false, status: 502, message: `Could not ${what}: ${error instanceof Error ? error.message : String(error)}` }) as const;

const repoInput = z.object({ repo: z.string().regex(REPO_NAME, "Name the repo as owner/name.") });

export type AddableOutcome = { ok: true; repos: Installable["repos"]; manageUrl: string } | { ok: false; status: number; message: string };

export type AddRepositoryDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  registry: () => Promise<Registry>;
  installable: () => Promise<Installable>;
  /** The registry row and its onboard_repo intent, in one transaction. */
  create: (repo: string, by: string) => Promise<void>;
  syncLabels: (groups: readonly LabelGroupSpec[]) => Promise<{ created: string[]; problems: string[] }>;
};

/** The repos the App can reach that are not registered yet, and where to grant it more. */
export async function listAddable(deps: Pick<AddRepositoryDeps, "user" | "registry" | "installable">): Promise<AddableOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  try {
    const [installable, registry] = await Promise.all([deps.installable(), deps.registry()]);
    const known = new Set(registry.map((r) => r.repo.toLowerCase()));
    return { ok: true, repos: installable.repos.filter((r) => !known.has(r.repo.toLowerCase())), manageUrl: installable.manageUrl };
  } catch (error) {
    return failed("list the GitHub App's repositories", error);
  }
}

export type AddOutcome = { ok: true; labelNote?: string } | { ok: false; status: number; message: string };

/**
 * Registers a repo the App reaches, enabled and not the default, and asks a runner to onboard it.
 * Its Repository label child is added too; a label that cannot be added only notes why.
 */
export async function addRepository(deps: AddRepositoryDeps, input: unknown): Promise<AddOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = repoInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "The repository is not valid.");
  const { repo } = parsed.data;
  const registry = await deps.registry();
  if (registry.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return invalid(`${repo} is already registered.`);
  if (registry.some((r) => (r.display_name ?? repoName(r.repo)).toLowerCase() === repoName(repo).toLowerCase())) {
    return invalid(`Another repository is already named ${repoName(repo)}. Rename it first, since labels match by name.`);
  }
  let installable: Installable;
  try {
    installable = await deps.installable();
  } catch (error) {
    return failed("list the GitHub App's repositories", error);
  }
  if (!installable.repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) return invalid(`The GitHub App cannot reach ${repo}. Grant it access first.`);
  try {
    await deps.create(repo, user.email);
  } catch (error) {
    return failed("add the repository", error);
  }
  try {
    const synced = await deps.syncLabels([{ group: REPOSITORY_GROUP, children: [repoName(repo)] }]);
    return synced.problems.length > 0 ? { ok: true, labelNote: synced.problems.join(" ") } : { ok: true };
  } catch (error) {
    return { ok: true, labelNote: `The Repository label was not added: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const intentRow = (kind: IntentKind, repo: string, at: Date) => ({ id: `panel:${kind}:${repo}:${randomUUID()}`, kind, detail: repo, created_at: at });

export async function writeNewRepository(database: Db, repo: string, by: string, at: Date) {
  await database.transaction(async (tx) => {
    await tx.insert(repoSettings).values({
      repo,
      enabled: true,
      is_default: false,
      onboarding_state: "analyzing",
      onboarding_detail: {},
      onboarding_started_at: at,
      onboarding_at: at,
      updated_at: at,
      updated_by: by,
    });
    await tx.insert(intents).values(intentRow("onboard_repo", repo, at));
  });
}

export const secretsInputSchema = z.object({
  repo: z.string().regex(REPO_NAME),
  values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
});
export type SecretsInput = z.input<typeof secretsInputSchema>;

export type SecretsDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  registry: () => Promise<Registry>;
  /** Whether this server holds a Modal token; without one the owner uses the CLI. */
  modalConfigured: () => boolean;
  upsert: (name: string, entries: Record<string, string>) => Promise<void>;
  /** Records the names now set and, with none missing, moves the repo on to building. */
  recordNames: (repo: string, names: string[]) => Promise<void>;
};

export const secretCommand = (repo: string, name: string) => `bun scripts/repo-secret.ts ${repo} ${name}`;

/**
 * Puts the pasted values in the repo's Modal secret, then records their names. The values exist
 * only in this call: they are never stored, logged, put in an intent or echoed in an error.
 */
export async function saveRepoSecrets(deps: SecretsDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = secretsInputSchema.safeParse(input);
  if (!parsed.success) return invalid("Name each secret with letters, digits and underscores.");
  const { repo } = parsed.data;
  const values = Object.fromEntries(Object.entries(parsed.data.values).filter(([, v]) => v.trim() !== ""));
  const names = Object.keys(values);
  if (names.length === 0) return invalid("Paste at least one value.");
  const row = (await deps.registry()).find((r) => r.repo === repo);
  if (!row) return invalid(`${repo} is not a registered repository.`);
  const { recipe } = parseDetail(row.onboarding_detail);
  const known = new Set((recipe?.env ?? []).map((e) => e.name));
  const unknown = names.filter((n) => !known.has(n));
  if (unknown.length > 0) return invalid(`The recipe names no env var ${unknown.join(", ")}.`);
  if (!deps.modalConfigured()) return invalid(`This panel has no cloud sandbox token. On the runner Mac, run ${secretCommand(repo, names[0]!)} for each secret.`);
  const secret = modalSecretName(repo);
  try {
    await deps.upsert(secret, values);
  } catch (error) {
    return { ok: false, status: 502, message: `The cloud sandbox secret store did not save ${secret}: ${scrubbed(error, Object.values(values)).message}` };
  }
  try {
    await deps.recordNames(repo, names);
    return { ok: true };
  } catch (error) {
    return failed("record the secret names", error);
  }
}

/**
 * Adds names to the row (never values) and, once the recipe's required ones are all set, moves a
 * repo that needed input on to building with an intent so a runner starts the build now.
 */
export async function recordSecretNames(database: Db, repo: string, names: readonly string[], at: Date) {
  await database.transaction(async (tx) => {
    const [row] = await tx.select().from(repoSettings).where(eq(repoSettings.repo, repo)).for("update");
    if (!row) throw new Error(`${repo} is not in the registry`);
    const detail = parseDetail(row.onboarding_detail);
    const secretsSet = [...new Set([...(detail.secretsSet ?? []), ...names])].sort();
    const missing = missingEnv(detail.recipe, secretsSet);
    const next: OnboardingState | null =
      row.onboarding_state === "needs_input" && detail.recipe && missing.length === 0 ? afterRecipe(detail.recipe, { ...detail, secretsSet }).state : row.onboarding_state;
    await tx
      .update(repoSettings)
      .set({
        onboarding_detail: { ...detail, secretsSet, missingSecrets: missing },
        onboarding_state: next,
        ...(next !== row.onboarding_state && { onboarding_at: at }),
      })
      .where(eq(repoSettings.repo, repo));
    if (next !== row.onboarding_state) await tx.insert(intents).values(intentRow("rebuild_repo_image", repo, at));
  });
}

export type RepoActionDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  registry: () => Promise<Registry>;
  request: (kind: "onboard_repo" | "rebuild_repo_image", repo: string) => Promise<void>;
};

/** Starts onboarding again from the recipe: the committed one if main has it now, else an agent writes one. */
export async function retryOnboarding(deps: RepoActionDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = repoInput.safeParse(input);
  if (!parsed.success) return invalid("Name the repo as owner/name.");
  const row = (await deps.registry()).find((r) => r.repo === parsed.data.repo);
  if (!row) return invalid(`${parsed.data.repo} is not a registered repository.`);
  if (parseDetail(row.onboarding_detail).run) return invalid(`A runner is still working on ${row.repo}. Wait for it to finish.`);
  try {
    await deps.request("onboard_repo", row.repo);
    return { ok: true };
  } catch (error) {
    return failed("start onboarding", error);
  }
}

/** Builds the warm image again from the recipe on the row; the current image serves until it is ready. */
export async function rebuildRepoImage(deps: RepoActionDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = repoInput.safeParse(input);
  if (!parsed.success) return invalid("Name the repo as owner/name.");
  const row = (await deps.registry()).find((r) => r.repo === parsed.data.repo);
  if (!row) return invalid(`${parsed.data.repo} is not a registered repository.`);
  const detail = parseDetail(row.onboarding_detail);
  if (!detail.recipe) return invalid(`${row.repo} has no setup recipe yet. Retry onboarding instead.`);
  const missing = missingEnv(detail.recipe, detail.secretsSet ?? []);
  if (missing.length > 0) return invalid(`Save ${missing.join(", ")} first.`);
  try {
    await deps.request("rebuild_repo_image", row.repo);
    return { ok: true };
  } catch (error) {
    return failed("request the rebuild", error);
  }
}

/** Retry resets the row to analyzing with the intent; a rebuild leaves the state to the runner. */
export async function writeRepoRequest(database: Db, kind: "onboard_repo" | "rebuild_repo_image", repo: string, at: Date) {
  await database.transaction(async (tx) => {
    if (kind === "onboard_repo") {
      await tx
        .update(repoSettings)
        .set({
          onboarding_state: "analyzing",
          onboarding_detail: sql`coalesce(${repoSettings.onboarding_detail}, '{}'::jsonb) - 'failure' - 'run'`,
          onboarding_started_at: at,
          onboarding_at: at,
        })
        .where(eq(repoSettings.repo, repo));
    }
    await tx.insert(intents).values(intentRow(kind, repo, at));
  });
}
