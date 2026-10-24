import type { IssueRow } from "../../db/schema";
import type { IntentDraft, Verdict } from "../webhooks";

export type JobSource = "linear";

export type Job = IssueRow;

export type WebhookScope = { teamKey: string; label: string };

export interface SourceWebhook {
  secretEnv: string;
  deliveryHeader: string;
  eventHeader: string;
  verify(raw: string, headers: Headers, secret: string, now?: number): Verdict;
  intent(body: unknown, scope: WebhookScope): IntentDraft | null;
}

export interface SourceAdapter<S extends JobSource> {
  source: S;
  webhook?: SourceWebhook;
}
