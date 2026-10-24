import { issuesQuery, sealOnly } from "@/lib/live-queries";

export async function POST() {
  return Response.json(await sealOnly(issuesQuery()), {
    headers: { "Cache-Control": "no-store" },
  });
}
