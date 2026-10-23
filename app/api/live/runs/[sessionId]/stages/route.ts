import { parseSessionId, sealOnly, sessionStagesQuery } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/runs/[sessionId]/stages">,
) {
  const sessionId = parseSessionId((await params).sessionId);
  if (!sessionId) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  return Response.json(await sealOnly(sessionStagesQuery(sessionId)), {
    headers: { "Cache-Control": "no-store" },
  });
}
