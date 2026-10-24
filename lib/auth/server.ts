import { createNeonAuth } from "@neondatabase/auth/next/server";
import { isOwner } from "./owner";

export const auth = createNeonAuth({
  baseUrl: process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});

export async function assertOwner() {
  const { data } = await auth.getSession();
  if (!isOwner(data?.user?.email)) throw new Error("an owner session is required");
}
