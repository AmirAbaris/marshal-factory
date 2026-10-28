/**
 * Session ids are Claude's UUIDs, `evidence:<branch>`, or `mcp:<branch>` for Codex, and branches
 * carry slashes (`mcp:factory/FAC-61`). So an id travels in a query string, never a path segment.
 */
const SESSION_ID = /^[\w.:-]+(?:\/[\w.:-]+)*$/;
const MAX_SESSION_ID = 128;

export const parseSessionId = (value: string | null | undefined) =>
  value && value.length <= MAX_SESSION_ID && SESSION_ID.test(value) ? value : undefined;

export type RunFeed = "agents" | "events" | "stages";

/** The live route that renews one of a run's sealed feeds. */
export const runFeedPath = (feed: RunFeed, sessionId: string) => `/api/live/runs/${feed}?${new URLSearchParams({ session: sessionId })}`;

/** The activity page with the run open on the right. */
export const activityHref = (sessionId: string) => `/activity?${new URLSearchParams({ run: sessionId })}`;

/** The same page with its open detail in full view or back in the side panel; every other param stays. */
export const fullViewHref = (pathname: string, params: URLSearchParams, full: boolean) => {
  const next = new URLSearchParams(params);
  if (full) next.set("full", "1");
  else next.delete("full");
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
};

/** Reads the session id a run feed route was called with. */
export const sessionParam = (request: Request) => parseSessionId(new URL(request.url).searchParams.get("session"));
