import { jobStagesQuery, parseJobKey, sealOnly } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/jobs/[key]/stages">,
) {
  const key = parseJobKey((await params).key);
  if (!key) {
    return Response.json({ error: "invalid job key" }, { status: 400 });
  }
  return Response.json(await sealOnly(jobStagesQuery(key)), {
    headers: { "Cache-Control": "no-store" },
  });
}
