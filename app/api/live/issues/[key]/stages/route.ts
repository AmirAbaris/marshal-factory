import { issueStagesQuery, parseIssueKey, sealOnly } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/issues/[key]/stages">,
) {
  const key = parseIssueKey((await params).key);
  if (!key) {
    return Response.json({ error: "invalid issue key" }, { status: 400 });
  }
  return Response.json(await sealOnly(issueStagesQuery(key)), {
    headers: { "Cache-Control": "no-store" },
  });
}
