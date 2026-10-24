// next.config.ts turns this off in Vercel preview builds, whose Neon branches have no Realtime config the build can read.
export const liveUpdates = process.env.NEXT_PUBLIC_LIVE_UPDATES !== "off";
