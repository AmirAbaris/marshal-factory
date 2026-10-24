import { z } from "zod";
import { GITHUB_API, githubRequest, installationToken, type RepoName } from "./app";

export type PullState = "open" | "closed" | "merged";
export type Mergeable = "mergeable" | "conflicting" | "unknown";
export type PullRequest = { state: PullState; mergeable: Mergeable; headSha: string };
export type HeadPull = { state: PullState; headSha: string; mergedAt: Date | null; closedAt: Date | null };
export type MergeResult =
  | { kind: "merged"; sha: string }
  | { kind: "not_mergeable"; message: string }
  | { kind: "head_moved"; message: string };

const PULL_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export function parsePullUrl(url: string): { repo: RepoName; number: number } {
  const match = PULL_URL.exec(url);
  if (!match) throw new Error(`${url} is not a GitHub pull request URL`);
  return { repo: match[1] as RepoName, number: Number(match[2]) };
}

const pullSchema = z.object({
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  head: z.object({ sha: z.string() }),
});

const stateOf = (pull: z.infer<typeof pullSchema>): PullState => (pull.merged_at ? "merged" : pull.state);

/** GitHub answers `mergeable: null` while it computes mergeability in the background. */
const mergeableOf = (mergeable: boolean | null): Mergeable =>
  mergeable === null ? "unknown" : mergeable ? "mergeable" : "conflicting";

const messageOf = (json: unknown) => z.object({ message: z.string() }).safeParse(json).data?.message ?? "";

export function pullsClient({ api, token }: { api: string; token: (repo: RepoName) => Promise<string> }) {
  return {
    async pullRequest(url: string): Promise<PullRequest> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await githubRequest(api, await token(repo), "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema.extend({ mergeable: z.boolean().nullable() }).parse(json);
      return { state: stateOf(pull), mergeable: mergeableOf(pull.mergeable), headSha: pull.head.sha };
    },

    async pullsForHead(repo: RepoName, branch: string): Promise<HeadPull[]> {
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", per_page: "100" });
      const { json } = await githubRequest(api, await token(repo), "GET", `/repos/${repo}/pulls?${query}`);
      return z
        .array(pullSchema)
        .parse(json)
        .map((pull) => ({
          state: stateOf(pull),
          headSha: pull.head.sha,
          mergedAt: pull.merged_at ? new Date(pull.merged_at) : null,
          closedAt: pull.closed_at ? new Date(pull.closed_at) : null,
        }));
    },

    async mergePull(url: string, headSha: string): Promise<MergeResult> {
      const { repo, number } = parsePullUrl(url);
      const { status, json } = await githubRequest(api, await token(repo), "PUT", `/repos/${repo}/pulls/${number}/merge`, {
        body: { merge_method: "squash", sha: headSha },
        allow: [405, 409],
      });
      if (status === 405) return { kind: "not_mergeable", message: messageOf(json) };
      if (status === 409) return { kind: "head_moved", message: messageOf(json) };
      return { kind: "merged", sha: z.object({ sha: z.string() }).parse(json).sha };
    },
  };
}

export type PullsClient = ReturnType<typeof pullsClient>;

export const github: PullsClient = pullsClient({ api: GITHUB_API, token: installationToken });
