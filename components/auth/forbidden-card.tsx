"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth/client";

export function ForbiddenCard() {
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
        <CardTitle>Not an owner</CardTitle>
        <CardDescription>This account is signed in but is not an owner of the factory.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button className="w-full" onClick={switchAccount} disabled={pending}>
          Sign in with another account
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
