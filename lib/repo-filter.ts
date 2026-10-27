import { REPO_NAME } from "./repo-name";

/** The repo the jobs page and the inbox last showed, so a page without `?repo` opens on it. */
export const REPO_FILTER_COOKIE = "jobs_repo";

/** `?repo=all` shows every repo, even when the cookie remembers one. */
export const ALL_REPOS = "all";

const pick = (raw: unknown) => (typeof raw === "string" && (raw === ALL_REPOS || REPO_NAME.test(raw)) ? raw : undefined);

/** The repo to show: a valid `?repo` wins over the cookie; null shows every repo. */
export function repoFilter(param: unknown, cookie: unknown): string | null {
  const chosen = pick(param) ?? pick(cookie);
  return chosen === undefined || chosen === ALL_REPOS ? null : chosen;
}
