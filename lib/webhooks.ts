import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FeedbackDetail } from "./inbox";
import type { JobId } from "./sources/shapes";

export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export function sameHex(given: string, expected: string) {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** `X-Hub-Signature-256` is `sha256=` plus the hex HMAC-SHA256 of the raw body. */
export function verifyGithub(rawBody: string, signature: string | null, secret: string | undefined): Verdict {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!signature || !sameHex(signature, `sha256=${hmacHex(secret, rawBody)}`)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

export type IntentDraft = {
  kind: "claim" | "stop" | "answer" | "merged" | "recheck_conflicts" | "request_changes" | "repo_push";
  /** Keys the intent instead of the delivery, so two deliveries about the same thing record it once. */
  key?: string;
  jobId?: JobId;
  prUrl?: string;
  detail?: string;
};

const githubPrSchema = z.object({
  action: z.string(),
  pull_request: z.object({ html_url: z.string(), merged: z.boolean().nullable().optional() }),
});
const githubPushSchema = z.object({
  ref: z.string(),
  after: z.string().optional(),
  repository: z.object({ default_branch: z.string(), full_name: z.string().optional() }),
  commits: z.array(z.object({ added: z.array(z.string()).optional(), removed: z.array(z.string()).optional(), modified: z.array(z.string()).optional() })).optional(),
});

/** At most this many changed paths go in a push's intent; a push with more counts as touching everything. */
export const PUSH_FILES_MAX = 2000;

export const repoPushDetailSchema = z.object({
  repo: z.string(),
  after: z.string().optional(),
  files: z.array(z.string()),
  /** The push changed more files than the intent keeps. */
  truncated: z.boolean().optional(),
});
export type RepoPushDetail = z.infer<typeof repoPushDetailSchema>;

const githubReviewSchema = z.object({
  action: z.string(),
  review: z.object({
    id: z.number().int(),
    state: z.string(),
    body: z.string().nullable().optional(),
    user: z.object({ login: z.string(), type: z.string() }).nullable(),
  }),
  pull_request: z.object({ html_url: z.string(), head: z.object({ ref: z.string() }).optional() }),
});

/** Reviews the factory forwards to the thread; an approval or a dismissal asks for nothing. */
const FORWARDED_REVIEWS = new Set(["changes_requested", "commented"]);

/**
 * A person's review asking for changes, or commenting on the code. Bots, the factory's own App
 * among them, are not reviewers here; Bugbot's findings reach the agent through its own playbook.
 */
function reviewIntent(body: unknown): IntentDraft | null {
  const { action, review, pull_request } = githubReviewSchema.parse(body);
  if (action !== "submitted" || !FORWARDED_REVIEWS.has(review.state.toLowerCase())) return null;
  if (!review.user || review.user.type === "Bot" || review.user.login.endsWith("[bot]")) return null;
  const detail: FeedbackDetail = {
    from: "github",
    id: `review:${review.id}`,
    reviewId: review.id,
    reviewer: review.user.login,
    state: review.state.toLowerCase(),
    body: review.body ?? "",
    ...(pull_request.head && { branch: pull_request.head.ref }),
  };
  return { kind: "request_changes", key: detail.id, prUrl: pull_request.html_url, detail: JSON.stringify(detail) };
}

/** A push to a default branch, with the paths it changed, so a runner can tell whether a warm image went stale. */
export function githubPushIntent(event: string, body: unknown): IntentDraft | null {
  if (event !== "push") return null;
  const push = githubPushSchema.parse(body);
  if (push.ref !== `refs/heads/${push.repository.default_branch}` || !push.repository.full_name) return null;
  const files = [...new Set((push.commits ?? []).flatMap((c) => [...(c.added ?? []), ...(c.removed ?? []), ...(c.modified ?? [])]))];
  const detail: RepoPushDetail = {
    repo: push.repository.full_name,
    ...(push.after && { after: push.after }),
    files: files.slice(0, PUSH_FILES_MAX),
    ...(files.length > PUSH_FILES_MAX && { truncated: true }),
  };
  return { kind: "repo_push", key: `repo-push:${push.repository.full_name}:${push.after ?? push.ref}`, detail: JSON.stringify(detail) };
}

/** What a GitHub delivery means: a merged PR, a person's review to forward, or a push to the default branch that may cause conflicts. */
export function githubIntent(event: string, body: unknown): IntentDraft | null {
  if (event === "pull_request") {
    const pr = githubPrSchema.parse(body);
    return pr.action === "closed" && pr.pull_request.merged
      ? { kind: "merged", prUrl: pr.pull_request.html_url }
      : null;
  }
  if (event === "pull_request_review") return reviewIntent(body);
  if (event === "push") {
    const push = githubPushSchema.parse(body);
    return push.ref === `refs/heads/${push.repository.default_branch}`
      ? { kind: "recheck_conflicts", detail: push.ref }
      : null;
  }
  return null;
}
