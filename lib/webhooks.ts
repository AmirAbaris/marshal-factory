import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const hmacHex = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

export function sameHex(given: string, expected: string) {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type Verdict = { ok: true } | { ok: false; reason: string };

/** `X-Hub-Signature-256` is `sha256=` plus the hex HMAC-SHA256 of the raw body. */
export function verifyGithub(rawBody: string, signature: string | null, secret: string): Verdict {
  if (!signature || !sameHex(signature, `sha256=${hmacHex(secret, rawBody)}`)) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true };
}

export type IntentDraft = {
  kind: "claim" | "stop" | "answer" | "merged" | "recheck_conflicts";
  issueKey?: string;
  linearId?: string;
  prUrl?: string;
  detail?: string;
};

const githubPrSchema = z.object({
  action: z.string(),
  pull_request: z.object({ html_url: z.string(), merged: z.boolean().nullable().optional() }),
});
const githubPushSchema = z.object({
  ref: z.string(),
  repository: z.object({ default_branch: z.string() }),
});

/** What a GitHub delivery means: a merged PR, or a push to the default branch that may cause conflicts. */
export function githubIntent(event: string, body: unknown): IntentDraft | null {
  if (event === "pull_request") {
    const pr = githubPrSchema.parse(body);
    return pr.action === "closed" && pr.pull_request.merged
      ? { kind: "merged", prUrl: pr.pull_request.html_url }
      : null;
  }
  if (event === "push") {
    const push = githubPushSchema.parse(body);
    return push.ref === `refs/heads/${push.repository.default_branch}`
      ? { kind: "recheck_conflicts", detail: push.ref }
      : null;
  }
  return null;
}
