import { timingSafeEqual } from "node:crypto";
import { attachDatabasePool } from "@neon/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../db/schema";
import { ingestBodySchema } from "../../lib/events";
import { ingest } from "../../lib/ingest";
import { githubIntent, linearIntent, verifyGithub, verifyLinear, type IntentDraft } from "../../lib/webhooks";

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
attachDatabasePool(pool);
const db = drizzle(pool, { schema });

function authorized(request: Request) {
  const expected = Buffer.from(`Bearer ${process.env.FACTORY_INGEST_SECRET}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Stores the delivery and the intent it implies in one transaction. A delivery id seen before
 * stores nothing, so a redelivery or replay has no effect.
 */
async function record(source: string, deliveryId: string, event: string, payload: unknown, intent: IntentDraft | null) {
  return db.transaction(async (tx) => {
    const now = new Date();
    const fresh = await tx
      .insert(schema.webhookDeliveries)
      .values({ delivery_id: `${source}:${deliveryId}`, source, event, received_at: now, payload })
      .onConflictDoNothing()
      .returning({ id: schema.webhookDeliveries.delivery_id });
    if (fresh.length === 0) return { duplicate: true, intent: null };
    if (intent) {
      await tx.insert(schema.intents).values({
        id: `${source}:${deliveryId}`,
        kind: intent.kind,
        issue_key: intent.issueKey,
        linear_id: intent.linearId,
        pr_url: intent.prUrl,
        detail: intent.detail,
        created_at: now,
      });
    }
    return { duplicate: false, intent: intent?.kind ?? null };
  });
}

async function linearWebhook(request: Request) {
  const raw = await request.text();
  const verdict = verifyLinear(raw, request.headers.get("linear-signature"), process.env.LINEAR_WEBHOOK_SECRET!);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get("linear-delivery");
  if (!deliveryId) return Response.json({ error: "missing Linear-Delivery" }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  const intent = linearIntent(body, {
    teamKey: process.env.FACTORY_TEAM_KEY ?? "FAC",
    label: process.env.FACTORY_LABEL ?? "factory",
  });
  return Response.json(await record("linear", deliveryId, request.headers.get("linear-event") ?? "?", body, intent));
}

async function githubWebhook(request: Request) {
  const raw = await request.text();
  const verdict = verifyGithub(raw, request.headers.get("x-hub-signature-256"), process.env.GITHUB_WEBHOOK_SECRET!);
  if (!verdict.ok) return Response.json({ error: verdict.reason }, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event") ?? "?";
  if (!deliveryId) return Response.json({ error: "missing X-GitHub-Delivery" }, { status: 400 });
  const body = JSON.parse(raw) as unknown;
  return Response.json(await record("github", deliveryId, event, body, githubIntent(event, body)));
}

async function ingestEvents(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const json = await request.json().catch(() => undefined);
  const parsed = ingestBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  return Response.json(await ingest(db, parsed.data));
}

const ROUTES: Record<string, (request: Request) => Promise<Response>> = {
  "/ingest": ingestEvents,
  "/webhooks/linear": linearWebhook,
  "/webhooks/github": githubWebhook,
};

const handler = {
  async fetch(request: Request): Promise<Response> {
    const route = ROUTES[new URL(request.url).pathname];
    if (!route || request.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
    try {
      return await route(request);
    } catch (error) {
      console.error(error);
      return Response.json({ error: "could not handle the request" }, { status: 500 });
    }
  },
};

export default handler;
