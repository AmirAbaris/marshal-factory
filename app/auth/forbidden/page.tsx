import type { Metadata } from "next";
import { ForbiddenCard } from "@/components/auth/forbidden-card";

export const metadata: Metadata = { title: "Forbidden · Marshal Factory" };

export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ForbiddenCard />
    </main>
  );
}
