import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { CONFIG_PATH, loadConfig } from "../lib/config";

// Creates, or finds, the Linear and GitHub webhooks that point at the ingest Function, and
// records their ids in the config. Re-running changes nothing.
//   bun scripts/install-webhooks.ts <owner/repo>

process.loadEnvFile(".env.local");
const repo = process.argv[2];
if (!repo) throw new Error("usage: bun scripts/install-webhooks.ts <owner/repo>");
const base = process.env.NEON_FUNCTION_INGEST_BASE_URL!.replace(/\/$/, "");
const config = loadConfig();

async function linear<T>(query: string, variables: object, schema: z.ZodType<T>) {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: config.linearApiKey, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = (await res.json()) as { data?: unknown; errors?: unknown };
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return schema.parse(json.data);
}

async function linearWebhook() {
  const url = `${base}/webhooks/linear`;
  const { webhooks } = await linear(
    `{ webhooks(first: 100) { nodes { id url } } }`,
    {},
    z.object({ webhooks: z.object({ nodes: z.array(z.object({ id: z.string(), url: z.string() })) }) }),
  );
  const existing = webhooks.nodes.find((w) => w.url === url);
  if (existing) return existing.id;
  const { teams } = await linear(
    `query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
    { key: config.factory.teamKey },
    z.object({ teams: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }),
  );
  const created = await linear(
    `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { webhook { id } } }`,
    {
      input: {
        url,
        teamId: teams.nodes[0]!.id,
        resourceTypes: ["Issue", "Comment"],
        secret: process.env.LINEAR_WEBHOOK_SECRET,
        label: "marshal-factory intake",
      },
    },
    z.object({ webhookCreate: z.object({ webhook: z.object({ id: z.string() }) }) }),
  );
  return created.webhookCreate.webhook.id;
}

function githubWebhook() {
  const url = `${base}/webhooks/github`;
  const gh = (args: string[], input?: string) =>
    execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
  const hooks = z
    .array(z.object({ id: z.number(), config: z.object({ url: z.string().optional() }) }))
    .parse(JSON.parse(gh(["api", `repos/${repo}/hooks`])));
  const existing = hooks.find((h) => h.config.url === url);
  if (existing) return existing.id;
  const body = {
    name: "web",
    active: true,
    events: ["pull_request", "push"],
    config: { url, content_type: "json", secret: process.env.GITHUB_WEBHOOK_SECRET, insecure_ssl: "0" },
  };
  return z
    .object({ id: z.number() })
    .parse(JSON.parse(gh(["api", "--method", "POST", `repos/${repo}/hooks`, "--input", "-"], JSON.stringify(body)))).id;
}

const ids = { linear: await linearWebhook(), github: githubWebhook() };
const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, Record<string, unknown>>;
raw.factory = { ...raw.factory, webhooks: { ...(raw.factory?.webhooks as object), linear: ids.linear, [repo]: ids.github } };
writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`);
// The mode option only applies when the file is created; the config holds secrets either way.
chmodSync(CONFIG_PATH, 0o600);
console.log(JSON.stringify(ids));
