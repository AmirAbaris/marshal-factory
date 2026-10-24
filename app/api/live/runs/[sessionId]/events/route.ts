import { parseSessionId, sealedResponse, sessionEventsQuery } from "@/lib/live-queries";

export async function POST(
  _request: Request,
  { params }: RouteContext<"/api/live/runs/[sessionId]/events">,
) {
  const sessionId = parseSessionId((await params).sessionId);
  if (!sessionId) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  return sealedResponse(sessionEventsQuery(sessionId));
}
