import type { SealedLiveQuery } from "@neon/realtime/client";
import { useLiveQuery } from "@neon/realtime-react";
import { useCallback, useState } from "react";
import { liveUpdates } from "@/lib/live-mode";

export type Feed<Row> = {
  initialData: Row[];
  /** Null when live updates are off for this build. */
  sealedQuery: SealedLiveQuery<Row> | null;
};

export type FeedStatus = "live" | "connecting" | "off";

/** Renewals must seal the same query, so each live query keeps its own route. */
async function fetchSealed<Row>(path: string) {
  const res = await fetch(path, { method: "POST" });
  if (!res.ok) {
    throw new Error(`Could not fetch the sealed query (${res.status})`);
  }
  return (await res.json()) as SealedLiveQuery<Row>;
}

function useLiveFeed<Row>(feed: Feed<Row>, path: string) {
  if (!feed.sealedQuery) throw new Error(`live updates are on but ${path} was not sealed`);
  // Server re-renders hand over a fresh sealed object for the same query; keep the first.
  const [query] = useState(feed.sealedQuery);
  const refreshQuery = useCallback(() => fetchSealed<Row>(path), [path]);
  const live = useLiveQuery(query, { refreshQuery, initialData: feed.initialData });
  const status: FeedStatus = live.status === "live" ? "live" : "connecting";
  return { rows: live.data ?? feed.initialData, status };
}

function useServerFeed<Row>(feed: Feed<Row>) {
  return { rows: feed.initialData, status: "off" as FeedStatus };
}

// liveUpdates is fixed at build time, so every render calls the same hook.
export const useFeed = liveUpdates ? useLiveFeed : useServerFeed;
