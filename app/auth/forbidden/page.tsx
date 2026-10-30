import type { Metadata } from "next";
import { connection } from "next/server";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { isAllowlisted } from "@/lib/auth/owner";
import { auth } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Forbidden · Abaris Factory" };

export default async function ForbiddenPage() {
  // The SDK logs a prerender attempt's cookie read as an error, so opt out of prerendering first.
  await connection();
  const { data } = await auth.getSession();
  const user = data?.user;
  const reason = user && !user.emailVerified && isAllowlisted(user.email) ? "unverified" : "not-owner";
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ForbiddenCard reason={reason} />
    </main>
  );
}
