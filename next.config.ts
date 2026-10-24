import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  env: { NEXT_PUBLIC_LIVE_UPDATES: process.env.VERCEL_ENV === "preview" ? "off" : "on" },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
