import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { GITHUB_APP_PATH } from "../config";
import { forbidInTest } from "../test-mode";

export const GITHUB_API = process.env.GITHUB_API_URL ?? "https://api.github.com";
export const GITHUB_API_VERSION = "2026-03-10";

export type RepoName = `${string}/${string}`;

export const appFileSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  client_id: z.string(),
  pem: z.string(),
  webhook_secret: z.string(),
  installation_id: z.number().int().optional(),
});
export type AppFile = z.infer<typeof appFileSchema>;

export function readAppFile(path = GITHUB_APP_PATH): AppFile {
  if (!existsSync(path)) throw new Error(`no GitHub App at ${path}; run bun scripts/setup-github-app.ts`);
  const text = readFileSync(path, "utf8");
  // Parse and schema errors can quote the file, which holds the private key, so neither is passed on.
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {}
  const parsed = appFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`${path} is not a valid GitHub App file; run bun scripts/setup-github-app.ts --force`);
  return parsed.data;
}

/**
 * What signs the app's JWT. Vercel has no app file, so it sets GITHUB_APP_ID and
 * GITHUB_APP_PRIVATE_KEY; GitHub takes the app id as the JWT issuer as well as the client id.
 */
export function appCredentials(env: Record<string, string | undefined> = process.env): Pick<AppFile, "client_id" | "pem"> {
  if (env.GITHUB_APP_PRIVATE_KEY) {
    if (!env.GITHUB_APP_ID) throw new Error("GITHUB_APP_PRIVATE_KEY is set but GITHUB_APP_ID is not");
    return { client_id: env.GITHUB_APP_ID, pem: env.GITHUB_APP_PRIVATE_KEY };
  }
  return readAppFile();
}

const base64url = (data: string | Buffer) => Buffer.from(data).toString("base64url");

/**
 * The app's RS256 JWT. GitHub hands out a PKCS#1 key, which node:crypto reads as is. `iat` sits a
 * minute in the past for clock drift and `exp` nine minutes ahead, inside GitHub's ten.
 */
export function appJwt(app: Pick<AppFile, "client_id" | "pem">, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const signed = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: app.client_id }))}`;
  return `${signed}.${base64url(sign("sha256", Buffer.from(signed), createPrivateKey(app.pem)))}`;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function githubRequest(
  api: string,
  auth: string,
  method: string,
  path: string,
  { body, allow = [] }: { body?: unknown; allow?: number[] } = {},
) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${auth}`,
      "user-agent": "marshal-factory",
      "x-github-api-version": GITHUB_API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok && !allow.includes(res.status)) {
    const message = z.object({ message: z.string() }).safeParse(json).data?.message ?? "";
    throw new GitHubError(`GitHub ${method} ${path} answered ${res.status}${message ? `: ${message}` : ""}`, res.status);
  }
  return { status: res.status, json };
}

const installationSchema = z.object({ id: z.number().int() });
const tokenSchema = z.object({ token: z.string(), expires_at: z.string() });
const REFRESH_BEFORE_MS = 5 * 60_000;

export function tokenSource({
  api,
  app,
  now = Date.now,
  onMint = () => {},
  refreshBeforeMs = REFRESH_BEFORE_MS,
}: {
  api: string;
  app: () => Pick<AppFile, "client_id" | "pem">;
  now?: () => number;
  onMint?: (repo: RepoName) => void;
  /** A cached token with less life left than this is minted again. */
  refreshBeforeMs?: number;
}) {
  const tokens = new Map<RepoName, { token: string; expiresAt: number }>();
  const minting = new Map<RepoName, Promise<string>>();

  async function mint(repo: RepoName) {
    const jwt = appJwt(app(), now());
    const installation = installationSchema.parse((await githubRequest(api, jwt, "GET", `/repos/${repo}/installation`)).json);
    const minted = tokenSchema.parse(
      (
        await githubRequest(api, jwt, "POST", `/app/installations/${installation.id}/access_tokens`, {
          body: { repositories: [repo.split("/")[1]] },
        })
      ).json,
    );
    onMint(repo);
    return { token: minted.token, expiresAt: Date.parse(minted.expires_at) };
  }

  function get(repo: RepoName): Promise<string> {
    const cached = tokens.get(repo);
    if (cached && cached.expiresAt - now() > refreshBeforeMs) return Promise.resolve(cached.token);
    let pending = minting.get(repo);
    if (!pending) {
      pending = mint(repo)
        .then((minted) => {
          tokens.set(repo, minted);
          return minted.token;
        })
        .finally(() => minting.delete(repo));
      minting.set(repo, pending);
    }
    return pending;
  }

  /** Drops a token GitHub refused, unless a newer one already replaced it. */
  function evict(repo: RepoName, token: string) {
    if (tokens.get(repo)?.token === token) tokens.delete(repo);
  }

  return { get, evict };
}

export type TokenSource = ReturnType<typeof tokenSource>;

const onMint = (repo: RepoName) => console.log(JSON.stringify({ at: new Date().toISOString(), event: `github app token minted for ${repo}` }));
const liveTokens = tokenSource({ api: GITHUB_API, app: () => appCredentials(), onMint });
// A sandbox's token file is rewritten every 40 minutes, so every token written there has at least 50 left.
const liveSandboxTokens = tokenSource({ api: GITHUB_API, app: () => appCredentials(), onMint, refreshBeforeMs: 50 * 60_000 });

export const installationTokens: TokenSource = {
  get(repo) {
    forbidInTest("the GitHub App");
    return liveTokens.get(repo);
  },
  evict: liveTokens.evict,
};

export const sandboxTokens: Pick<TokenSource, "get"> = {
  get(repo) {
    forbidInTest("the GitHub App");
    return liveSandboxTokens.get(repo);
  },
};
