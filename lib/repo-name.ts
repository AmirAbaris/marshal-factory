import type { RepoSettingsRow } from "../db/schema";

// Kept apart from lib/repositories.ts so client components can name repos without bundling the database.

/** A GitHub full name, owner/name. */
export const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;

/** The name part of owner/name. */
export const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

export const displayName = (row: Pick<RepoSettingsRow, "repo" | "display_name">) => row.display_name ?? repoName(row.repo);
