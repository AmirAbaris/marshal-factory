import { handleCommand } from "@/lib/slack-new-job";
import { slackRouteDeps } from "@/lib/slack-route-deps";

export const runtime = "nodejs";
export const maxDuration = 30;

/** Slack's slash command URL for `/factory`. The proxy lets it through; the signature is the check. */
export async function POST(request: Request) {
  return handleCommand(request, slackRouteDeps());
}
