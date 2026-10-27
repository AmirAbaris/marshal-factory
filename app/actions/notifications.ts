"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { reportedSlack } from "@/lib/machine";
import {
  requestSlackTest,
  saveNotifications as save,
  slackTestOutcome,
  type NotificationDeps,
  type NotificationInput,
} from "@/lib/notifications";
import { SlackApiError, slackClient } from "@/lib/slack-api";

const user = async () => (await auth.getSession()).data?.user;

/** Asks Slack about the channel when the panel has a token; without one, or when Slack can't be reached, it can't tell. */
async function checkChannel(channelId: string): ReturnType<NotificationDeps["checkChannel"]> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  try {
    await slackClient({ token, minGapMs: 0 }).channelInfo(channelId);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof SlackApiError)) return null;
    return {
      ok: false,
      message:
        error.code === "channel_not_found"
          ? `Slack has no channel ${channelId} the app can see. Invite the app to it first if it is private.`
          : `Slack refused the channel: ${error.code}.`,
    };
  }
}

const deps: NotificationDeps = {
  db,
  user,
  checkChannel,
  slackConfigured: async () => reportedSlack(await db.select().from(machines), Date.now())?.configured ?? false,
};

export async function saveNotifications(input: NotificationInput) {
  return save(deps, input);
}

export async function sendSlackTest(requestId: string) {
  return requestSlackTest(deps, requestId);
}

export async function slackTestStatus(intentId: string) {
  return slackTestOutcome(deps, intentId);
}
