import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../db/schema";
import { issues } from "../../db/schema";
import { loadConfig, type FactoryLimits } from "../config";
import type { Stage } from "../events";
import { attemptBranch } from "../factory";
import { linearClient, type LinearClient } from "../linear";
import { claimCommentId, resumeCommentId, stageCommentId } from "../resume";
import { hmacHex, sameHex, type IntentDraft, type Verdict } from "../webhooks";
import type { Job, SourceAdapter, SourceWebhook } from "./types";

/** Linear asks receivers to reject a webhookTimestamp more than a minute away from now. */
const LINEAR_MAX_SKEW_MS = 60_000;

/** The stop detail for a deleted issue; there is nothing left in Linear to double-check. */
export const DELETED = "the issue was deleted in Linear";

/** `Linear-Signature` is the hex HMAC-SHA256 of the raw body; the timestamp check comes after it. */
function verifyLinear(rawBody: string, signature: string | null, secret: string, now = Date.now()): Verdict {
  if (!signature || !sameHex(signature, hmacHex(secret, rawBody))) return { ok: false, reason: "bad signature" };
  const sent = (JSON.parse(rawBody) as { webhookTimestamp?: number }).webhookTimestamp;
  if (typeof sent !== "number" || Math.abs(now - sent) > LINEAR_MAX_SKEW_MS) {
    return { ok: false, reason: "stale webhookTimestamp" };
  }
  return { ok: true };
}

const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  team: z.object({ key: z.string() }).optional(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
  labelIds: z.array(z.string()).default([]),
  state: z.object({ type: z.string(), name: z.string() }).optional(),
});

const linearPayloadSchema = z.object({
  action: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  updatedFrom: z.record(z.string(), z.unknown()).optional(),
});

/**
 * What a Linear delivery means for the factory. A label or state change can arrive as one
 * delivery, so the current labels and state decide, with updatedFrom telling a removal apart.
 */
function linearIntent(body: unknown, opts: { teamKey: string; label: string }): IntentDraft | null {
  const payload = linearPayloadSchema.parse(body);
  if (payload.type === "Comment" && payload.action === "create") {
    const issueId = z.string().optional().parse(payload.data.issueId);
    return issueId ? { kind: "answer", linearId: issueId } : null;
  }
  if (payload.type !== "Issue") return null;
  const issue = linearIssueSchema.parse(payload.data);
  if (issue.team && issue.team.key !== opts.teamKey) return null;
  if (!issue.identifier.startsWith(`${opts.teamKey}-`)) return null;
  const base = { issueKey: issue.identifier, linearId: issue.id };
  const factoryLabel = issue.labels.find((l) => l.name.toLowerCase() === opts.label.toLowerCase());

  if (payload.action === "remove") return { kind: "stop", ...base, detail: DELETED };
  if (issue.state?.type === "canceled" && payload.updatedFrom && "stateId" in payload.updatedFrom) {
    return { kind: "stop", ...base, detail: `issue moved to ${issue.state.name} in Linear` };
  }
  const labelsBefore = z.array(z.string()).optional().parse(payload.updatedFrom?.labelIds);
  if (labelsBefore && !factoryLabel) {
    // The labels changed and factory is not among them now. The payload names only the current
    // labels, so a swap looks the same as a removal; the runner checks whether it was running.
    return { kind: "stop", ...base, detail: `the ${opts.label} label was removed in Linear` };
  }
  if (factoryLabel && issue.state?.type === "unstarted") return { kind: "claim", ...base };
  return null;
}

const webhook: SourceWebhook = {
  secretEnv: "LINEAR_WEBHOOK_SECRET",
  deliveryHeader: "Linear-Delivery",
  eventHeader: "Linear-Event",
  verify: (raw, headers, secret, now) => verifyLinear(raw, headers.get("linear-signature"), secret, now),
  intent: linearIntent,
};

export type LinearDeps = {
  client: LinearClient;
  db: NodePgDatabase<typeof schema>;
  limits: FactoryLimits;
};

async function runtimeDeps(): Promise<LinearDeps> {
  const config = loadConfig();
  // Loaded on first use: the ingest Function imports this module for its webhook and has no runner database.
  const { db } = await import("../../db/client");
  return { client: linearClient(config.linearApiKey), db, limits: config.factory };
}

type Team = Awaited<ReturnType<LinearClient["team"]>>;

const stateId = (team: Team, teamKey: string, name: string) => {
  const state = team.states.find((s) => s.name === name);
  if (!state) throw new Error(`Linear team ${teamKey} has no state ${name}`);
  return state.id;
};

/** What reaches Linear when an issue enters a stage. Stages without an entry stay in the panel. */
type WriteBack = {
  state?: string;
  labels?: { add?: string[]; remove?: string[] };
  comment?: (issue: Job) => string;
};
const FAILED_LABEL = "factory-failed";

const writeBackTable = (factoryLabel: string): Partial<Record<Stage, WriteBack>> => ({
  pr: {
    state: "In Review",
    comment: (i) => `marshal-factory has a pull request ready for review: ${i.pr_url}\n\n${i.stage_summary ?? ""}`.trim(),
  },
  waiting: {
    comment: (i) =>
      `marshal-factory stopped and needs an answer before it can continue:\n\n${i.question ?? i.stage_summary}`,
  },
  // Back to Todo without the factory label, so the runner does not pick it up again in a loop.
  // Adding the label again retries it as a new attempt.
  failed: {
    state: "Todo",
    labels: { add: [FAILED_LABEL], remove: [factoryLabel] },
    comment: (i) =>
      `marshal-factory gave up on this issue (attempt ${i.attempt}): ${i.stage_summary}\n\nAdd the \`${factoryLabel}\` label again to retry.`,
  },
  merged: { state: "Done" },
});

/** Records the id before posting, so a crash in between can never make our own comment look like a reply. */
async function postComment({ db, client }: LinearDeps, issue: Job, id: string, body: string) {
  await db
    .update(issues)
    .set({
      factory_comment_ids: sql`case when ${issues.factory_comment_ids} ? ${id} then ${issues.factory_comment_ids} else ${issues.factory_comment_ids} || jsonb_build_array(${id}::text) end`,
    })
    .where(eq(issues.linear_id, issue.linear_id));
  await client.comment(issue.linear_id, id, body);
}

export function createLinearAdapter(load: () => LinearDeps | Promise<LinearDeps>): SourceAdapter<"linear"> {
  let loaded: LinearDeps | undefined;
  const deps = async () => (loaded ??= await load());
  let team: Team | undefined;
  const teamOf = async ({ client, limits }: LinearDeps) => (team ??= await client.team(limits.teamKey));

  async function labelChanges(d: LinearDeps, labels: WriteBack["labels"]) {
    if (!labels) return {};
    const { id } = await teamOf(d);
    const ids = (names: string[] = []) => Promise.all(names.map((name) => d.client.labelId(id, name)));
    return { addedLabelIds: await ids(labels.add), removedLabelIds: await ids(labels.remove) };
  }

  return {
    source: "linear",
    webhook,

    async ready() {
      const { client, limits } = await deps();
      const nodes = await client.readyIssues(limits.teamKey, limits.label);
      return nodes.map((n) => ({
        externalId: n.id,
        key: n.identifier,
        title: n.title,
        url: n.url,
        description: n.description,
        sourceState: n.state.name,
        labels: n.labels.nodes.map((l) => l.name),
      }));
    },

    async announceClaim(job) {
      const d = await deps();
      await d.client.update(job.linear_id, {
        stateId: stateId(await teamOf(d), d.limits.teamKey, "In Progress"),
        ...(job.attempt > 1 ? await labelChanges(d, { remove: [FAILED_LABEL] }) : {}),
      });
      await postComment(
        d,
        job,
        claimCommentId(job.linear_id, job.attempt),
        job.attempt > 1
          ? `Picked up by marshal-factory again (attempt ${job.attempt}, branch ${attemptBranch(job.key, job.attempt)}).`
          : "Picked up by marshal-factory.",
      );
    },

    async writeBack(job, transition) {
      const d = await deps();
      const action = writeBackTable(d.limits.label)[transition.stage];
      if (!action) return null;
      if (action.state || action.labels) {
        const team = await teamOf(d);
        await d.client.update(job.linear_id, {
          ...(action.state ? { stateId: stateId(team, d.limits.teamKey, action.state) } : {}),
          ...(await labelChanges(d, action.labels)),
        });
      }
      if (action.comment) {
        await postComment(d, job, stageCommentId(job.linear_id, transition.eventId), action.comment(job));
      }
      return { sourceState: action.state };
    },

    async acknowledgeReplies(job, replyIds) {
      await postComment(await deps(), job, resumeCommentId(job.linear_id, replyIds), "Answer received, resuming.");
    },

    describe: (job) => `Linear issue ${job.key}`,
  };
}

export const linear = createLinearAdapter(runtimeDeps);
