import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { redact } from "@/lib/slack";

// What every request from Slack shares, whichever route it reaches: the signature check, the
// owner-only refusal, ephemeral replies and request ids derived from what Slack sends.

/** Slack signs each request; one older than this is a replay. */
export const MAX_SKEW_SECONDS = 5 * 60;

export const NOT_OWNER = "Only the factory owner can act from Slack.";
export const NO_TOKEN = "The panel has no SLACK_BOT_TOKEN, so it can't act from Slack.";

/** Checks `X-Slack-Signature`: v0, HMAC-SHA256 of `v0:<timestamp>:<raw body>` with the signing secret. */
export function verifySignature(secret: string, timestamp: string | null, signature: string | null, body: string, nowMs: number) {
  if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > MAX_SKEW_SECONDS) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`);
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The raw body of a request Slack signed, or null when the signature is missing, wrong or too old. */
export async function signedBody(request: Request, secret: string | undefined, nowMs: number) {
  const body = await request.text();
  return verifySignature(secret ?? "", request.headers.get("x-slack-request-timestamp"), request.headers.get("x-slack-signature"), body, nowMs) ? body : null;
}

export const invalidSignature = () => new Response("invalid signature", { status: 401 });

/** A UUID derived from the seed, as the panel's actions want for a request id: the same seed is the same request. */
export function uuidFrom(seed: string) {
  const h = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A note only the user who acted sees; it can quote what an agent or a source wrote, so it is redacted. */
export const ephemeral = (secrets: readonly string[], text: string) => ({ response_type: "ephemeral", replace_original: false, text: redact(text, secrets) });

/** What may be shown of an unexpected error: its message, redacted, never a stack. */
export const safeMessage = (secrets: readonly string[], error: unknown) =>
  `Something went wrong: ${redact(error instanceof Error ? error.message : String(error), secrets).slice(0, 300)}`;

export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
