import { asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "@/db/schema";
import { jobs, repoSettings, type RepoSettingsRow } from "@/db/schema";
import { isOwner, type SessionUser } from "@/lib/auth/owner";
import { executionSchema, type Execution } from "@/lib/execution";
import type { Harness } from "@/lib/harness";
import { autonomySchema } from "@/lib/merge-decision";
import { displayName, REPO_NAME, repoName } from "@/lib/repo-name";
import type { EffectiveHarness, SettingsOutcome } from "@/lib/settings";
import { OVERRIDE_GROUPS, type SourceOverrides } from "@/lib/ticket-overrides";

// The repositories the factory works in. An issue picks one with a child of the Repository label
// group, named by the repo's display name; without one it goes to the default repo. Per repo, a
// default harness and place sit between the ticket's labels and Settings.

export const REPOSITORY_GROUP = OVERRIDE_GROUPS.repository;

type Db = NodePgDatabase<typeof schema>;
export type Registry = readonly RepoSettingsRow[];

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const defaultRepo = (registry: Registry) => registry.find((r) => r.is_default) ?? null;

/** The repos a Repository label names: by display name, else by name part, else by full name. More than one is ambiguous. */
function labelMatches(registry: Registry, name: string) {
  for (const key of [displayName, (r: RepoSettingsRow) => repoName(r.repo), (r: RepoSettingsRow) => r.repo]) {
    const matches = registry.filter((r) => same(key(r), name));
    if (matches.length > 0) return matches;
  }
  return [];
}

/** The one repo a Repository label names; a name more than one repo answers to names none. */
export function repoForLabel(registry: Registry, name: string) {
  const matches = labelMatches(registry, name);
  return matches.length === 1 ? matches[0] : undefined;
}

/** The label that names `row`: its display name, or its full name while another repo shares the display name. */
export function repoLabel(registry: Registry, row: Pick<RepoSettingsRow, "repo" | "display_name">) {
  const name = displayName(row);
  return registry.some((r) => r.repo !== row.repo && same(displayName(r), name)) ? row.repo : name;
}

export type RepoRoute = { repo: string | null; problem?: string };

/** The repo a ticket's overrides pick; one that cannot apply goes to the default and says why. Null only with no default. */
export function routeRepo(asked: Pick<SourceOverrides, "repository">, registry: Registry): RepoRoute {
  const fallback = defaultRepo(registry);
  const repo = fallback?.repo ?? null;
  const to = fallback ? `the default repository ${fallback.repo}` : "the runner's first repository";
  const picked = asked.repository;
  if (picked.length === 0) return { repo };
  if (picked.length > 1) {
    return { repo, problem: `The issue has more than one ${REPOSITORY_GROUP} label (${picked.map((name) => `"${name}"`).join(", ")}), so it runs in ${to}.` };
  }
  const name = picked[0]!;
  const matches = labelMatches(registry, name);
  if (matches.length > 1) {
    return { repo, problem: `The ${REPOSITORY_GROUP} label "${name}" names more than one repository (${matches.map((r) => r.repo).join(", ")}), so it runs in ${to}.` };
  }
  const match = matches[0];
  if (!match) return { repo, problem: `The ${REPOSITORY_GROUP} label "${name}" names no repository the factory knows, so it runs in ${to}.` };
  if (!match.enabled) return { repo, problem: `The ${REPOSITORY_GROUP} label "${name}" names ${match.repo}, which is disabled, so it runs in ${to}.` };
  return { repo: match.repo };
}

/** One Repository child per enabled repo, by the label that names it alone. */
export function desiredRepositoryGroup(registry: Registry) {
  const names: string[] = [];
  for (const r of registry) {
    const name = repoLabel(registry, r);
    if (r.enabled && !names.some((n) => same(n, name))) names.push(name);
  }
  return { group: REPOSITORY_GROUP, children: names };
}

export type LaunchDefaults = { harness: EffectiveHarness; execution: Execution };

/**
 * The repo's default harness and place over Settings; the ticket's labels then go over these. A
 * default harness other than the Settings one starts on its first current model, as a Harness
 * label does. One that no runner reports enabled is a problem and Settings apply.
 */
export function withRepoDefaults(settings: LaunchDefaults, repo: RepoSettingsRow | undefined, harnesses: readonly Harness[] | null) {
  const problems: string[] = [];
  let harness = settings.harness;
  if (repo?.provider && repo.provider !== settings.harness.provider) {
    const model = harnesses?.find((h) => h.id === repo.provider && h.enabled)?.models[0]?.slug;
    if (model) harness = { provider: repo.provider, model, from: "repo" };
    else problems.push(`${repo.repo} defaults to harness ${repo.provider}, which no runner reports enabled with a model, so its jobs start on the Settings harness.`);
  }
  return { defaults: { harness, execution: repo?.execution ?? settings.execution }, problems };
}

export const readRegistry = (database: Db): Promise<RepoSettingsRow[]> => database.select().from(repoSettings).orderBy(asc(repoSettings.repo));

/** Per repo, its jobs that are not merged or failed, and when its newest job was claimed. */
export type RepoStats = { repo: string; open: number; lastAt: Date | null };

export const readRepoStats = (database: Db): Promise<RepoStats[]> =>
  database
    .select({
      repo: jobs.repo,
      open: sql<number>`(count(*) filter (where ${jobs.stage} not in ('merged', 'failed')))::int`,
      lastAt: sql<Date | null>`max(${jobs.claimed_at})`.mapWith(jobs.claimed_at),
    })
    .from(jobs)
    .groupBy(jobs.repo);

const isUniqueViolation = (error: unknown) => (error as { code?: string; cause?: { code?: string } })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505";

/**
 * Adds the runner's checkouts to the registry and makes the first one the default when none is.
 * It never changes a row that exists, so the panel's edits win. A new repo whose name part another
 * repo already goes by is named by its full name, since labels match by display name.
 */
export async function registerRepos(database: Db, repos: readonly string[], by: string, at: Date) {
  if (repos.length === 0) return;
  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('repo_settings.display_name'))`);
    const named: Pick<RepoSettingsRow, "repo" | "display_name">[] = await tx.select({ repo: repoSettings.repo, display_name: repoSettings.display_name }).from(repoSettings);
    const added: (typeof repoSettings.$inferInsert)[] = [];
    for (const repo of repos) {
      if (named.some((r) => r.repo === repo)) continue;
      const display_name = named.some((r) => same(displayName(r), repoName(repo)) || same(r.repo, repoName(repo))) ? repo : null;
      named.push({ repo, display_name });
      added.push({ repo, display_name, updated_at: at, updated_by: by });
    }
    if (added.length > 0) await tx.insert(repoSettings).values(added).onConflictDoNothing();
  });
  try {
    await database.execute(
      sql`update ${repoSettings} set is_default = true where repo = ${repos[0]} and enabled and not exists (select 1 from ${repoSettings} where is_default)`,
    );
  } catch (error) {
    // Another runner made its first repo the default in between; one default is all that is wanted.
    if (!isUniqueViolation(error)) throw error;
  }
}

/** Moves the default to `repo` in one transaction, so there is never a moment with two. */
export async function writeDefaultRepo(database: Db, repo: string, by: string, at: Date) {
  await database.transaction(async (tx) => {
    await tx.update(repoSettings).set({ is_default: false }).where(sql`${repoSettings.is_default} and ${repoSettings.repo} <> ${repo}`);
    const [moved] = await tx
      .update(repoSettings)
      .set({ is_default: true, updated_at: at, updated_by: by })
      .where(sql`${repoSettings.repo} = ${repo} and ${repoSettings.enabled}`)
      .returning({ repo: repoSettings.repo });
    if (!moved) throw new Error(`${repo} is not an enabled repository`);
  });
}

const GLOB = z.string().trim().min(1).max(200);

export const repositoryInputSchema = z.object({
  repo: z.string().regex(REPO_NAME, "Name the repo as owner/name."),
  displayName: z
    .string()
    .trim()
    .min(1, "Give the repository a name.")
    .max(60, "Keep the name under 60 characters.")
    .regex(/^[^,\n]+$/, "The name can't contain commas or line breaks."),
  enabled: z.boolean(),
  /** A harness's provider instance id; null means Settings decide. */
  provider: z.string().trim().min(1).nullable(),
  execution: executionSchema.nullable(),
  autonomy: autonomySchema,
  /** Null means the default globs. */
  protectedPaths: z.array(GLOB).max(100, "Keep it to 100 protected paths.").nullable(),
  /** Null means the default limit. */
  maxChangedLines: z.number().int("Use a whole number of lines.").positive("Use at least 1 line.").max(100_000, "Keep the limit under 100,000 lines.").nullable(),
});
export type RepositoryInput = z.input<typeof repositoryInputSchema>;
export type RepositoryChoice = z.output<typeof repositoryInputSchema>;

export const defaultRepoInputSchema = z.object({ repo: z.string().regex(REPO_NAME, "Name the repo as owner/name.") });
export type DefaultRepoInput = z.input<typeof defaultRepoInputSchema>;

export async function writeRepository(database: Db, choice: RepositoryChoice, by: string, at: Date) {
  const updated = await database
    .update(repoSettings)
    .set({
      display_name: same(choice.displayName, repoName(choice.repo)) ? null : choice.displayName,
      enabled: choice.enabled,
      provider: choice.provider,
      execution: choice.execution,
      autonomy: choice.autonomy,
      protected_paths: choice.protectedPaths,
      max_changed_lines: choice.maxChangedLines,
      updated_at: at,
      updated_by: by,
    })
    .where(eq(repoSettings.repo, choice.repo))
    .returning({ repo: repoSettings.repo });
  if (updated.length === 0) throw new Error(`${choice.repo} is not in the registry`);
}

export type RepositoryDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  registry: () => Promise<Registry>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
  save: (choice: RepositoryChoice, by: string) => Promise<void>;
};

const FORBIDDEN = { ok: false, status: 403, message: "Only the factory owner can change repositories." } as const;
const invalid = (message: string): SettingsOutcome => ({ ok: false, status: 400, message });
const failed = (error: unknown): SettingsOutcome => ({
  ok: false,
  status: 502,
  message: `Could not save the repository: ${error instanceof Error ? error.message : String(error)}`,
});

/** Edits one registered repo. The default stays enabled, and display names stay unique, since labels match by them. */
export async function saveRepository(deps: RepositoryDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = repositoryInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "The repository is not valid.");
  const choice = parsed.data;
  const registry = await deps.registry();
  const row = registry.find((r) => r.repo === choice.repo);
  if (!row) return invalid(`${choice.repo} is not a registered repository.`);
  if (row.is_default && !choice.enabled) return invalid("The default repository can't be disabled. Make another one the default first.");
  const taken = registry.find((r) => r.repo !== choice.repo && (same(displayName(r), choice.displayName) || same(r.repo, choice.displayName)));
  if (taken) return invalid(`${taken.repo} is already named ${choice.displayName}.`);
  // Only a changed harness is checked: one kept from before may no longer be reported, and other edits must still save.
  if (choice.provider && choice.provider !== row.provider) {
    const harnesses = await deps.harnesses();
    if (harnesses && !harnesses.some((h) => h.id === choice.provider && h.enabled)) return invalid(`No machine reports an enabled harness ${choice.provider}.`);
  }
  try {
    await deps.save(choice, user.email);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}

export type DefaultRepoDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  registry: () => Promise<Registry>;
  save: (repo: string, by: string) => Promise<void>;
};

export async function makeDefaultRepo(deps: DefaultRepoDeps, input: unknown): Promise<SettingsOutcome> {
  const user = await deps.user();
  if (!user || !isOwner(user)) return FORBIDDEN;
  const parsed = defaultRepoInputSchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "The repository is not valid.");
  const row = (await deps.registry()).find((r) => r.repo === parsed.data.repo);
  if (!row) return invalid(`${parsed.data.repo} is not a registered repository.`);
  if (!row.enabled) return invalid(`${row.repo} is disabled. Enable it before making it the default.`);
  try {
    await deps.save(row.repo, user.email);
    return { ok: true };
  } catch (error) {
    return failed(error);
  }
}
