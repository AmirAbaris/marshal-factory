import { z } from "zod";
import { forbidInTest } from "../test-mode";
import { appCredentials, appJwt, GITHUB_API, githubRequest, installationTokens, type AppFile, type RepoName, type TokenSource } from "./app";

// What the GitHub App's installations can reach: the repos the panel can add, and a file on a
// repo's default branch.

export type InstallableRepo = { repo: string; private: boolean; description: string | null };
export type Installable = { repos: InstallableRepo[]; manageUrl: string };

/** Where the owner picks which repositories the app can reach. */
export const INSTALLATIONS_URL = "https://github.com/settings/installations";

const installationsSchema = z.array(z.object({ id: z.number().int(), html_url: z.string().optional() }));
const tokenSchema = z.object({ token: z.string() });
const reposSchema = z.object({
  total_count: z.number().int(),
  repositories: z.array(z.object({ full_name: z.string(), private: z.boolean(), description: z.string().nullable(), archived: z.boolean().optional() })),
});

/** Every repo any installation of the app can reach, archived ones left out. */
export async function installationRepos({ api = GITHUB_API, app = () => appCredentials() }: { api?: string; app?: () => Pick<AppFile, "client_id" | "pem"> } = {}): Promise<Installable> {
  const jwt = appJwt(app());
  const installations = installationsSchema.parse((await githubRequest(api, jwt, "GET", "/app/installations?per_page=100")).json);
  const repos: InstallableRepo[] = [];
  for (const installation of installations) {
    const { token } = tokenSchema.parse((await githubRequest(api, jwt, "POST", `/app/installations/${installation.id}/access_tokens`)).json);
    for (let page = 1; page <= 10; page++) {
      const listed = reposSchema.parse((await githubRequest(api, token, "GET", `/installation/repositories?per_page=100&page=${page}`)).json);
      for (const r of listed.repositories) if (!r.archived) repos.push({ repo: r.full_name, private: r.private, description: r.description });
      if (page * 100 >= listed.total_count) break;
    }
  }
  const only = installations.length === 1 ? installations[0]!.html_url : undefined;
  return { repos: repos.sort((a, b) => a.repo.localeCompare(b.repo)), manageUrl: only ?? INSTALLATIONS_URL };
}

const contentSchema = z.object({ content: z.string(), encoding: z.literal("base64") });

/** A file's text on the repo's default branch, or null when it has none. */
export async function fileOnDefaultBranch(repo: RepoName, path: string, { api = GITHUB_API, tokens = installationTokens }: { api?: string; tokens?: Pick<TokenSource, "get"> } = {}) {
  forbidInTest("the GitHub App");
  const { status, json } = await githubRequest(api, await tokens.get(repo), "GET", `/repos/${repo}/contents/${path}`, { allow: [404] });
  if (status === 404) return null;
  const file = contentSchema.parse(json);
  return Buffer.from(file.content, "base64").toString("utf8");
}
