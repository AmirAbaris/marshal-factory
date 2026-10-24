import "./test-guard";
import assert from "node:assert/strict";
import { commentId, linearClient, LinearError } from "../lib/linear";

type Vars = { name?: string; input: { id: string; name: string; body: string } };
type Handler = (query: string, variables: Vars) => unknown;

function fakeLinear(handler: Handler, outages: ("reset-before" | "reset-after" | 500 | 429 | "ok")[]) {
  const requests: { query: string; variables: Vars }[] = [];
  const sleeps: number[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    requests.push(request);
    const outage = outages.shift() ?? "ok";
    if (outage === "reset-before") throw new TypeError("fetch failed: ECONNRESET");
    const answer = handler(request.query, request.variables);
    if (outage === "reset-after") throw new TypeError("fetch failed: ECONNRESET");
    if (typeof outage === "number") return new Response("<html>busy</html>", { status: outage });
    return Response.json(answer);
  }) as unknown as typeof fetch;
  const client = linearClient("key", { fetch: fetchFake, sleep: async (ms) => void sleeps.push(ms) });
  return { client, requests, sleeps };
}

const teamHandler: Handler = () => ({ data: { teams: { nodes: [{ id: "t1", key: "FAC", states: { nodes: [] } }] } } });

{
  const { client, requests, sleeps } = fakeLinear(teamHandler, ["reset-before", "reset-before"]);
  assert.deepEqual(await client.team("FAC"), { id: "t1", states: [] }, "two resets, then the read succeeds");
  assert.equal(requests.length, 3);
  assert.equal(sleeps.length, 2, "it backed off between attempts");
  assert.ok(sleeps.every((ms) => ms > 0 && ms < 2_000), "and the backoff is short");
}
{
  const { client, requests } = fakeLinear(teamHandler, ["reset-before", "reset-before", "reset-before"]);
  await assert.rejects(client.team("FAC"), /ECONNRESET/, "a third reset surfaces the error");
  assert.equal(requests.length, 3, "after three attempts");
}
for (const status of [500, 429] as const) {
  const { client, requests } = fakeLinear(teamHandler, [status]);
  await client.team("FAC");
  assert.equal(requests.length, 2, `${status} is retried`);
}
{
  const { client, requests } = fakeLinear(teamHandler, [500, 500, 500]);
  await assert.rejects(client.team("FAC"), (error) => error instanceof LinearError && /answered 500/.test(error.message), "persistent 5xx surfaces as a LinearError");
  assert.equal(requests.length, 3);
}
{
  const { client, requests } = fakeLinear(() => ({ errors: [{ message: "Argument Validation Error" }] }), []);
  await assert.rejects(client.team("FAC"), /Argument Validation Error/);
  assert.equal(requests.length, 1, "a Linear error answer is never retried");
}

{
  const comments = new Map<string, string>();
  const server: Handler = (_query, { input }) => {
    if (comments.has(input.id)) return { errors: [{ message: "conflict on insert", extensions: {} }] };
    comments.set(input.id, input.body);
    return { data: { commentCreate: { success: true } } };
  };
  const { client, requests } = fakeLinear(server, ["reset-after"]);
  const id = commentId("issue-1", "claim");
  await client.comment("issue-1", id, "Picked up");
  assert.equal(requests.length, 2, "the reset after Linear applied the write is retried");
  assert.equal(comments.size, 1, "and the retried comment is not posted twice");
  assert.deepEqual([...comments.keys()], [id]);
  assert.equal(new Set(requests.map((r) => r.variables.input.id)).size, 1, "both attempts carry the same comment id");
}

{
  const labels = new Map<string, string>();
  const server: Handler = (query, variables) => {
    if (query.includes("issueLabelCreate")) {
      const { id, name } = variables.input;
      if (labels.has(id)) return { errors: [{ message: "conflict on insert" }] };
      labels.set(id, name);
      return { data: { issueLabelCreate: { success: true } } };
    }
    return { data: { issueLabels: { nodes: [...labels].filter(([, n]) => n === variables.name).map(([id]) => ({ id, team: { id: "t1" } })) } } };
  };
  const { client } = fakeLinear(server, ["ok", "reset-after"]);
  const id = await client.labelId("t1", "needs-human");
  assert.equal(labels.size, 1, "a retried label create makes one label");
  assert.equal(await client.labelId("t1", "needs-human"), id, "and later lookups find that label");
}

await assert.rejects(linearClient("key").team("FAC"), /Linear API was called during a regression run/, "the real client refuses to run under the test harness");

console.log("linear regressions passed");
