import { handleInteraction } from "@/lib/slack-interactions";
import { slackRouteDeps } from "@/lib/slack-route-deps";

export const runtime = "nodejs";
/** The work after the ack follows the runner's answer for up to 50 seconds. */
export const maxDuration = 60;

/** Slack's interactivity URL: button clicks, modal submissions and the "Send to factory" shortcut. The proxy lets it through; the signature is the check. */
export async function POST(request: Request) {
  return handleInteraction(request, slackRouteDeps());
}
