import type { IssueRow } from "../../db/schema";
import type { Stage } from "../events";
import type { IntentDraft, Verdict } from "../webhooks";

export type JobSource = "linear";

export type Job = IssueRow;

/** What a source reports for work it wants claimed; the claim turns it into a row. */
export type JobDraft = {
  externalId: string;
  key: string;
  title: string;
  url: string;
  description: string | null;
  sourceState: string;
  labels: string[];
};

export type StageTransition = { stage: Stage; eventId: string };

/** A write-back that reached the source. `sourceState` is the state it set, when the stage maps to one. */
export type WriteBackResult = { sourceState?: string } | null;

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
  ready(): Promise<JobDraft[]>;
  announceClaim(job: Job): Promise<void>;
  writeBack(job: Job, transition: StageTransition): Promise<WriteBackResult>;
  acknowledgeReplies(job: Job, replyIds: readonly string[]): Promise<void>;
  /** The noun phrase naming the job in messages to the thread, such as "Linear issue FAC-7". */
  describe(job: Pick<Job, "key">): string;
}
