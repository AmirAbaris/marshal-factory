import { after } from "next/server";
import { inboxDeps } from "@/lib/inbox-deps";
import { panelUrl, secretValues } from "@/lib/slack";
import { postResponse, slackClient } from "@/lib/slack-api";
import { ownerFromAllowlist, type InteractionDeps } from "@/lib/slack-interactions";

/** What Slack's routes act with: the app's env, the panel's inbox and new-job actions as the owner, and next/server's after. */
export function slackRouteDeps(): InteractionDeps {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  return {
    signingSecret: process.env.SLACK_SIGNING_SECRET?.trim(),
    ownerSlackId: process.env.SLACK_OWNER_USER_ID?.trim(),
    slack: token ? slackClient({ token, baseUrl: process.env.SLACK_API_URL?.trim() || undefined, minGapMs: 0 }) : null,
    respond: postResponse,
    inbox: inboxDeps(async () => ownerFromAllowlist()),
    panelUrl: panelUrl(),
    secrets: secretValues(process.env),
    after,
  };
}
