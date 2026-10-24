import { z } from "zod";
import { hmacHex, sameHex, type IntentDraft, type Verdict } from "../webhooks";
import type { SourceAdapter, SourceWebhook } from "./types";

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

export const linear: SourceAdapter<"linear"> = { source: "linear", webhook };
