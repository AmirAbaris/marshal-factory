"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { attempt } from "./attempt";
import { VerifyEmailForm } from "./verify-email-form";

type Credentials = { email: string; password: string };

const MODES = {
  "sign-in": {
    description: "Sign in with the owner account.",
    submit: "Sign in",
    pending: "Signing in",
    passwordAutoComplete: "current-password",
    password: z.string().min(1, "Enter your password"),
    call: (credentials: Credentials) => authClient.signIn.email(credentials),
  },
  "sign-up": {
    description: "Create the owner account. You confirm the email with a code next.",
    submit: "Create account",
    pending: "Creating account",
    passwordAutoComplete: "new-password",
    password: z.string().min(8, "Use at least 8 characters"),
    call: (credentials: Credentials) => authClient.signUp.email({ ...credentials, name: credentials.email }),
  },
} as const;

export function CredentialsForm({ mode }: { mode: keyof typeof MODES }) {
  const config = MODES[mode];
  const router = useRouter();
  const [verifying, setVerifying] = useState<string | null>(null);
  const form = useForm<Credentials>({
    resolver: zodResolver(z.object({ email: z.email("Enter a valid email address"), password: config.password })),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(credentials: Credentials) {
    const failed = await attempt(() => config.call(credentials), `${config.submit} failed`);
    if (failed && !failed.unverified) {
      form.setError("root", { message: failed.message });
      return;
    }
    // A new account, or a sign-in the server refused for an unconfirmed email, has just been sent a code.
    if (failed || mode === "sign-up") {
      setVerifying(credentials.email);
      return;
    }
    router.replace("/");
    router.refresh();
  }

  if (verifying) return <VerifyEmailForm email={verifying} />;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Marshal Factory</CardTitle>
        <CardDescription>{config.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-5">
            <Controller
              name="email"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input {...field} id="email" type="email" autoComplete="email" aria-invalid={fieldState.invalid} />
                  {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                </Field>
              )}
            />
            <Controller
              name="password"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    {...field}
                    id="password"
                    type="password"
                    autoComplete={config.passwordAutoComplete}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                </Field>
              )}
            />
            {form.formState.errors.root && <FieldError match>{form.formState.errors.root.message}</FieldError>}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? config.pending : config.submit}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
