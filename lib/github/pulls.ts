import { z } from "zod";
import type { BugbotFinding, ChangedFile, CheckState, MergeMethod } from "../merge-decision";
import { GITHUB_API, GitHubError, githubRequest, installationTokens, type RepoName, type TokenSource } from "./app";

export type PullState = "open" | "closed" | "merged";
export type Mergeable = "mergeable" | "conflicting" | "unknown";
export type PullRequest = { state: PullState; mergeable: Mergeable; headSha: string; title: string };
export type HeadPull = { state: PullState; headSha: string; mergedAt: Date | null; closedAt: Date | null };
export type BranchPull = { url: string; state: "open" | "merged" };
export type MergeResult =
  | { kind: "merged"; sha: string }
  | { kind: "not_mergeable"; message: string }
  | { kind: "head_moved"; message: string }
  | { kind: "forbidden"; message: string };
export type MergeOptions = { method?: MergeMethod; title?: string; message?: string };
/** What the factory's merge needs to know about the PR right before it merges. */
export type MergeCandidate = { state: PullState; headSha: string; baseRef: string; title: string; number: number; commits: number; mergeCommitSha: string | null };
export type RepoMerging = { method: MergeMethod; canPush: boolean };
export type CommentWrite = "created" | "updated" | "unchanged";

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

export type PullDetail = { state: PullState; mergeable: Mergeable; headSha: string; baseRef: string };

const fileSchema = z.object({
  filename: z.string(),
  previous_filename: z.string().optional(),
  additions: z.number(),
  deletions: z.number(),
  patch: z.string().optional(),
});

const checkRunSchema = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  app: z.object({ slug: z.string() }).nullable().optional(),
});
type CheckRun = z.infer<typeof checkRunSchema>;
const combinedStatusSchema = z.object({ state: z.string(), total_count: z.number() });

const PASSING = new Set(["success", "neutral", "skipped"]);
const isBugbot = (run: CheckRun) => /bugbot/i.test(run.name);

/**
 * Every check run and commit status on a commit, Bugbot's run aside. A commit nothing reported on
 * yet is pending: CI may not have started.
 */
export function checkStateOf(runs: readonly CheckRun[], status: z.infer<typeof combinedStatusSchema>): { checks: CheckState; bugbotFinished: boolean } {
  const others = runs.filter((run) => !isBugbot(run));
  const states: CheckState[] = others.map((run) =>
    run.status !== "completed" ? "pending" : PASSING.has(run.conclusion ?? "") ? "success" : "failure",
  );
  if (status.total_count > 0) states.push(status.state === "success" ? "success" : status.state === "pending" ? "pending" : "failure");
  const checks: CheckState = states.includes("failure") ? "failure" : states.length === 0 || states.includes("pending") ? "pending" : "success";
  return { checks, bugbotFinished: runs.some((run) => isBugbot(run) && run.status === "completed") };
}

const statusesSchema = combinedStatusSchema.extend({ statuses: z.array(z.object({ context: z.string(), state: z.string() })).default([]) });

/** The names of the failed check runs and commit statuses on a commit, Bugbot's run aside. */
export function failedChecksOf(runs: readonly CheckRun[], status: z.infer<typeof statusesSchema>): string[] {
  const failedRuns = runs.filter((run) => !isBugbot(run) && run.status === "completed" && !PASSING.has(run.conclusion ?? "")).map((run) => run.name);
  const statuses = status.statuses.filter((s) => s.state === "failure" || s.state === "error").map((s) => s.context);
  return [...new Set([...failedRuns, ...statuses])];
}

const MERGE_METHOD_FLAGS = { squash: "allow_squash_merge", merge: "allow_merge_commit", rebase: "allow_rebase_merge" } as const;

/** Squash when the repo allows it, else the first method it allows; a repo that hides its flags gets squash. */
export function mergeMethodOf(repo: Partial<Record<(typeof MERGE_METHOD_FLAGS)[MergeMethod], boolean>>): MergeMethod {
  const allowed = (Object.keys(MERGE_METHOD_FLAGS) as MergeMethod[]).filter((m) => repo[MERGE_METHOD_FLAGS[m]] !== false);
  return allowed[0] ?? "squash";
}

const SEVERITY = /\*\*(High|Medium|Low) Severity\*\*/;
const BUGBOT_LOGIN = /^cursor(\[bot\])?$/;

const threadsSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          nodes: z.array(
            z.object({
              isResolved: z.boolean(),
              comments: z.object({ nodes: z.array(z.object({ author: z.object({ login: z.string() }).nullable(), body: z.string() })) }),
            }),
          ),
        }),
      }),
    }),
  }),
});

/** Bugbot's findings: its review threads, each with the severity its first comment states. */
export function bugbotFindingsOf(json: unknown): BugbotFinding[] {
  const { nodes } = threadsSchema.parse(json).data.repository.pullRequest.reviewThreads;
  return nodes.flatMap((thread) => {
    const first = thread.comments.nodes[0];
    const severity = first && BUGBOT_LOGIN.test(first.author?.login ?? "") ? SEVERITY.exec(first.body)?.[1] : undefined;
    return severity ? [{ severity: severity.toLowerCase() as BugbotFinding["severity"], resolved: thread.isResolved }] : [];
  });
}

const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } body } } } }
    }
  }
}`;

const FILE_PAGES = 30;

export function pullsClient({ api, tokens }: { api: string; tokens: TokenSource }) {
  // A cached token GitHub stops accepting (revoked, or the installation changed) is dropped and
  // minted again once; a second 401 is a real failure.
  async function request(repo: RepoName, method: string, path: string, options?: Parameters<typeof githubRequest>[4]) {
    const token = await tokens.get(repo);
    try {
      return await githubRequest(api, token, method, path, options);
    } catch (error) {
      if (!(error instanceof GitHubError && error.status === 401)) throw error;
      tokens.evict(repo, token);
      return githubRequest(api, await tokens.get(repo), method, path, options);
    }
  }

  return {
    async pullRequest(url: string): Promise<PullRequest> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema.extend({ mergeable: z.boolean().nullable(), title: z.string() }).parse(json);
      return { state: stateOf(pull), mergeable: mergeableOf(pull.mergeable), headSha: pull.head.sha, title: pull.title };
    },

    async pullsForHead(repo: RepoName, branch: string): Promise<HeadPull[]> {
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", per_page: "100" });
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls?${query}`);
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

    /** The branch's open PR, else its latest merged one; null when it has neither. */
    async pullRequestForBranch(repo: RepoName, branch: string): Promise<BranchPull | null> {
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${branch}`, state: "all", per_page: "100" });
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls?${query}`);
      const pulls = z
        .array(pullSchema.extend({ html_url: z.string() }))
        .parse(json)
        .map((pull) => ({ url: pull.html_url, state: stateOf(pull), mergedAt: pull.merged_at ?? "" }));
      const open = pulls.find((p) => p.state === "open");
      if (open) return { url: open.url, state: "open" };
      const merged = pulls.filter((p) => p.state === "merged").sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
      return merged ? { url: merged.url, state: "merged" } : null;
    },

    async pullDetail(url: string): Promise<PullDetail> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema.extend({ mergeable: z.boolean().nullable(), base: z.object({ ref: z.string() }) }).parse(json);
      return { state: stateOf(pull), mergeable: mergeableOf(pull.mergeable), headSha: pull.head.sha, baseRef: pull.base.ref };
    },

    /** How many commits the base branch has that the head lacks. */
    async behindBy(repo: RepoName, base: string, head: string): Promise<number> {
      const { json } = await request(repo, "GET", `/repos/${repo}/compare/${encodeURIComponent(base)}...${head}`);
      return z.object({ behind_by: z.number() }).parse(json).behind_by;
    },

    async pullFiles(url: string): Promise<ChangedFile[]> {
      const { repo, number } = parsePullUrl(url);
      const files: ChangedFile[] = [];
      for (let page = 1; page <= FILE_PAGES; page++) {
        const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`);
        const batch = z.array(fileSchema).parse(json);
        files.push(
          ...batch.map((f) => ({ path: f.filename, previousPath: f.previous_filename, additions: f.additions, deletions: f.deletions, patch: f.patch })),
        );
        if (batch.length < 100) break;
      }
      return files;
    },

    async checkState(repo: RepoName, sha: string) {
      const [runs, status] = await Promise.all([
        request(repo, "GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
        request(repo, "GET", `/repos/${repo}/commits/${sha}/status`),
      ]);
      return checkStateOf(z.object({ check_runs: z.array(checkRunSchema) }).parse(runs.json).check_runs, combinedStatusSchema.parse(status.json));
    },

    async bugbotFindings(url: string): Promise<BugbotFinding[]> {
      const { repo, number } = parsePullUrl(url);
      const [owner, name] = repo.split("/");
      const { json } = await request(repo, "POST", "/graphql", { body: { query: THREADS_QUERY, variables: { owner, name, number } } });
      const errors = z.object({ errors: z.array(z.object({ message: z.string() })) }).safeParse(json);
      if (errors.success) throw new Error(`GitHub GraphQL: ${errors.data.errors.map((e) => e.message).join("; ")}`);
      return bugbotFindingsOf(json);
    },

    /** `sha` pins the head, so a push since the decision makes GitHub refuse the merge. */
    async mergePull(url: string, headSha: string, { method = "squash", title, message }: MergeOptions = {}): Promise<MergeResult> {
      const { repo, number } = parsePullUrl(url);
      const { status, json } = await request(repo, "PUT", `/repos/${repo}/pulls/${number}/merge`, {
        body: { merge_method: method, sha: headSha, ...(title && { commit_title: title }), ...(message && { commit_message: message }) },
        allow: [403, 404, 405, 409],
      });
      if (status === 403 || status === 404) return { kind: "forbidden", message: messageOf(json) || `GitHub answered ${status}` };
      if (status === 405) return { kind: "not_mergeable", message: messageOf(json) };
      if (status === 409) return { kind: "head_moved", message: messageOf(json) };
      return { kind: "merged", sha: z.object({ sha: z.string() }).parse(json).sha };
    },

    async mergeCandidate(url: string): Promise<MergeCandidate> {
      const { repo, number } = parsePullUrl(url);
      const { json } = await request(repo, "GET", `/repos/${repo}/pulls/${number}`);
      const pull = pullSchema
        .extend({ base: z.object({ ref: z.string() }), title: z.string(), commits: z.number().int(), merge_commit_sha: z.string().nullable() })
        .parse(json);
      return {
        state: stateOf(pull),
        headSha: pull.head.sha,
        baseRef: pull.base.ref,
        title: pull.title,
        number,
        commits: Math.max(1, pull.commits),
        mergeCommitSha: pull.merge_commit_sha,
      };
    },

    /** The merge method to use, and whether the token may push at all, a cheap probe before a merge. */
    async repoMerging(repo: RepoName): Promise<RepoMerging> {
      const { json } = await request(repo, "GET", `/repos/${repo}`);
      const flags = z
        .object({
          allow_squash_merge: z.boolean().optional(),
          allow_merge_commit: z.boolean().optional(),
          allow_rebase_merge: z.boolean().optional(),
          permissions: z.object({ push: z.boolean().optional() }).optional(),
        })
        .parse(json);
      return { method: mergeMethodOf(flags), canPush: flags.permissions?.push !== false };
    },

    /** The commit's checks with the names of those that failed, Bugbot's run aside. */
    async commitChecks(repo: RepoName, sha: string): Promise<{ checks: CheckState; failed: string[] }> {
      const [runs, status] = await Promise.all([
        request(repo, "GET", `/repos/${repo}/commits/${sha}/check-runs?per_page=100`),
        request(repo, "GET", `/repos/${repo}/commits/${sha}/status?per_page=100`),
      ]);
      const checkRuns = z.object({ check_runs: z.array(checkRunSchema) }).parse(runs.json).check_runs;
      const combined = statusesSchema.parse(status.json);
      return { checks: checkStateOf(checkRuns, combined).checks, failed: failedChecksOf(checkRuns, combined) };
    },

    /** Creates or edits the one comment on the PR that carries `marker`, so a decision is never posted twice. */
    async upsertComment(url: string, marker: string, body: string): Promise<CommentWrite> {
      const { repo, number } = parsePullUrl(url);
      const commentSchema = z.array(z.object({ id: z.number(), body: z.string().nullable().optional() }));
      for (let page = 1; page <= FILE_PAGES; page++) {
        const { json } = await request(repo, "GET", `/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`);
        const batch = commentSchema.parse(json);
        const ours = batch.find((c) => c.body?.includes(marker));
        if (ours) {
          if (ours.body === body) return "unchanged";
          await request(repo, "PATCH", `/repos/${repo}/issues/comments/${ours.id}`, { body: { body } });
          return "updated";
        }
        if (batch.length < 100) break;
      }
      await request(repo, "POST", `/repos/${repo}/issues/${number}/comments`, { body: { body } });
      return "created";
    },

    /** Opens a PR, or returns the open one GitHub already has for the branch. */
    async createPull(repo: RepoName, pull: { title: string; head: string; base: string; body: string }): Promise<{ url: string }> {
      const { status, json } = await request(repo, "POST", `/repos/${repo}/pulls`, { body: pull, allow: [422] });
      if (status !== 422) return { url: z.object({ html_url: z.string() }).parse(json).html_url };
      const query = new URLSearchParams({ head: `${repo.split("/")[0]}:${pull.head}`, state: "open" });
      const existing = z.array(z.object({ html_url: z.string() })).parse((await request(repo, "GET", `/repos/${repo}/pulls?${query}`)).json)[0];
      if (!existing) throw new GitHubError(`GitHub POST /repos/${repo}/pulls answered 422: ${messageOf(json)}`, 422);
      return { url: existing.html_url };
    },
  };
}

export type PullsClient = ReturnType<typeof pullsClient>;

export const github: PullsClient = pullsClient({ api: GITHUB_API, tokens: installationTokens });
