"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { attempt } from "./attempt";

const schema = z.object({
  otp: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from the email"),
});

type Code = z.infer<typeof schema>;

export function VerifyEmailForm({ email }: { email: string }) {
  const router = useRouter();
  const [resent, setResent] = useState(false);
  const form = useForm<Code>({ resolver: zodResolver(schema), defaultValues: { otp: "" } });

  async function onSubmit({ otp }: Code) {
    const failed = await attempt(() => authClient.emailOtp.verifyEmail({ email, otp }), "Verification failed");
    if (failed) {
      form.setError("otp", { message: failed.message });
      return;
    }
    router.replace("/");
    router.refresh();
  }

  async function resend() {
    setResent(false);
    form.clearErrors("root");
    const failed = await attempt(
      () => authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" }),
      "Could not send a new code",
    );
    if (failed) form.setError("root", { message: failed.message });
    else setResent(true);
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Verify your email</CardTitle>
        <CardDescription>We sent a code to {email}. It expires after 15 minutes.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <FieldGroup>
            <Controller
              name="otp"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="otp">Verification code</FieldLabel>
                  <Input
                    {...field}
                    id="otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    aria-invalid={fieldState.invalid}
                  />
                  {resent && <FieldDescription>A new code is on its way.</FieldDescription>}
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <FieldError errors={[form.formState.errors.root]} />
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? "Verifying" : "Verify"}
            </Button>
            <Button type="button" variant="ghost" onClick={resend}>
              Send a new code
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
