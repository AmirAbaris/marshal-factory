import type { Metadata } from "next";
import { CredentialsForm } from "@/components/auth/credentials-form";

export const metadata: Metadata = { title: "Create the owner account · Marshal Factory" };

// Neon Auth refuses sign-ups unless the operator turns them on for owner creation.
export default function SignUpPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <CredentialsForm mode="sign-up" />
    </main>
  );
}
