import { after } from "next/server";
import { inboxDeps } from "@/lib/inbox-deps";
import { panelUrl, secretValues } from "@/lib/slack";
import { postResponse, slackClient } from "@/lib/slack-api";
import { handleInteraction, ownerFromAllowlist } from "@/lib/slack-interactions";

export const runtime = "nodejs";
/** The work after the ack follows the runner's answer for up to 50 seconds. */
export const maxDuration = 60;

/** Slack's interactivity URL: button clicks and modal submissions on the factory's messages. The proxy lets it through; the signature is the check. */
export async function POST(request: Request) {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  return handleInteraction(request, {
    signingSecret: process.env.SLACK_SIGNING_SECRET?.trim(),
    ownerSlackId: process.env.SLACK_OWNER_USER_ID?.trim(),
    slack: token ? slackClient({ token, baseUrl: process.env.SLACK_API_URL?.trim() || undefined, minGapMs: 0 }) : null,
    respond: postResponse,
    inbox: inboxDeps(async () => ownerFromAllowlist()),
    panelUrl: panelUrl(),
    secrets: secretValues(process.env),
    after,
  });
}
