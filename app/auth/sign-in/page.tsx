import type { Metadata } from "next";
import { CredentialsForm } from "@/components/auth/credentials-form";

export const metadata: Metadata = { title: "Sign in · Marshal Factory" };

export default function SignInPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <CredentialsForm mode="sign-in" />
    </main>
  );
}
