import { jobEvidenceQuery, parseJobKey, sealedResponse } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/jobs/[key]/evidence">,
) {
  const key = parseJobKey((await params).key);
  if (!key) {
    return Response.json({ error: "invalid job key" }, { status: 400 });
  }
  return sealedResponse(jobEvidenceQuery(key));
}
