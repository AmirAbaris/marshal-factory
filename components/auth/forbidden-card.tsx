"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth/client";

export function ForbiddenCard() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function switchAccount() {
    setPending(true);
    await authClient.signOut().catch(() => undefined);
    router.replace("/auth/sign-in");
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
      </CardContent>
    </Card>
  );
}
