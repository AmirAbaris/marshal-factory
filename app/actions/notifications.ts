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

const user = async () => (await auth.getSession()).data?.user;

const deps: NotificationDeps = {
  db,
  user,
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
