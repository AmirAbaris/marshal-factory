"use client";

import { createRealtimeClient } from "@neon/realtime/client";
import { drizzleParsers } from "@neon/realtime-drizzle/client";
import { RealtimeProvider } from "@neon/realtime-react";
import { useState, type ReactNode } from "react";
import { liveUpdates } from "@/lib/live-mode";

export function RealtimeRoot({ children }: { children: ReactNode }) {
  return liveUpdates ? <LiveRoot>{children}</LiveRoot> : children;
}

function LiveRoot({ children }: { children: ReactNode }) {
  // Created in the tree, not at module level: the server render must never open a socket.
  const [client] = useState(() =>
    createRealtimeClient({
      url: process.env.NEXT_PUBLIC_NEON_REALTIME_URL!,
      parsers: { ...drizzleParsers },
    }),
  );
  return <RealtimeProvider client={client}>{children}</RealtimeProvider>;
}
