"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth/client";

const COPY = {
  "not-owner": {
    title: "Not an owner",
    description: "This account is signed in but is not an owner of the factory.",
    action: "Sign in with another account",
  },
  unverified: {
    title: "Email not verified",
    description: "The owner account has not confirmed its email yet. Sign in again to get a code.",
    action: "Sign in again",
  },
} as const;

export function ForbiddenCard({ reason }: { reason: keyof typeof COPY }) {
  const copy = COPY[reason];
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function switchAccount() {
    setPending(true);
    setFailure(null);
    try {
      await authClient.signOut();
      router.replace("/auth/sign-in");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-out failed");
      setPending(false);
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button className="w-full" onClick={switchAccount} disabled={pending}>
          {copy.action}
        </Button>
        {failure && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
