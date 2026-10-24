import { createNeonAuth } from "@neondatabase/auth/next/server";
import { cache } from "react";
import { isOwner } from "./owner";

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});

export const assertOwner = cache(async () => {
  const { data } = await auth.getSession();
  if (!isOwner(data?.user)) throw new Error("an owner session is required");
});
