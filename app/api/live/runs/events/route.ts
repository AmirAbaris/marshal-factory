import { sealedResponse, sessionEventsQuery } from "@/lib/live-queries";
import { sessionParam } from "@/lib/run-links";

export async function POST(request: Request) {
  const sessionId = sessionParam(request);
  if (!sessionId) {
    return Response.json({ error: "invalid session id" }, { status: 400 });
  }
  return sealedResponse(sessionEventsQuery(sessionId));
}
