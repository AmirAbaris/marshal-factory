import { jobsQuery, sealOnly } from "@/lib/live-queries";

export async function POST() {
  return Response.json(await sealOnly(jobsQuery()), {
    headers: { "Cache-Control": "no-store" },
  });
}
