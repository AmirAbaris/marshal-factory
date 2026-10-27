"use client";

import { useState, useSyncExternalStore } from "react";

const noSubscription = () => () => {};

/** Runs `read` only in the browser, so server HTML never bakes in the server's clock or timezone. */
export function useAfterHydration<T extends string | number>(
  read: () => T,
  fallback: T,
): T {
  return useSyncExternalStore(noSubscription, read, () => fallback);
}

export function Time({ date }: { date: Date }) {
  const text = useAfterHydration(
    () => date.toLocaleTimeString("en-GB", { hour12: false }),
    "",
  );
  return <time dateTime={date.toISOString()}>{text}</time>;
}

/** A dense timestamp: the time for today, the day and month before that. */
export function ShortTime({ date }: { date: Date }) {
  const text = useAfterHydration(() => {
    const today = new Date().toDateString() === date.toDateString();
    return today
      ? date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })
      : date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }, "");
  return <time dateTime={date.toISOString()}>{text}</time>;
}

export function useNow(intervalMs: number): number | null {
  const [store] = useState(() => createClock(intervalMs));
  return useSyncExternalStore(store.subscribe, store.read, () => null);
}

function createClock(intervalMs: number) {
  let now = Date.now();
  return {
    // Must return the same value until the next tick, or React re-renders in a loop.
    read: () => now,
    subscribe(notify: () => void) {
      now = Date.now();
      const id = setInterval(() => {
        now = Date.now();
        notify();
      }, intervalMs);
      return () => clearInterval(id);
    },
  };
}
