import type { IngestResult } from "../lib/ingest";
import { forbidInTest } from "../lib/test-mode";
import { config } from "./config";

/** Where the runner's own events go; regressions swap `post` for the ingest projection itself. */
export const ingestClient = {
  async post(event: Record<string, unknown>): Promise<Pick<IngestResult, "refused">> {
    forbidInTest("the deployed ingest function");
    const res = await fetch(config.ingestUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${config.secret}`, "content-type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`ingest answered ${res.status}: ${await res.text()}`);
    return (await res.json()) as Pick<IngestResult, "refused">;
  },
};

export async function postEvent(event: Record<string, unknown>) {
  const { refused } = await ingestClient.post(event);
  for (const refusal of refused) console.log(JSON.stringify({ at: new Date().toISOString(), event: "stage refused", ...refusal }));
}
