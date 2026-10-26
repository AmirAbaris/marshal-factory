"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveRepoAutonomy } from "@/app/actions/settings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { AUTONOMY_LABELS, AUTONOMY_LEVELS, autonomySchema, type Autonomy, type RepoPolicy } from "@/lib/merge-decision";

export type RepoMerging = { repo: string; policy: RepoPolicy };

const AUTONOMY_HELP: Record<Autonomy, string> = {
  off: "Every pull request is ready for your review. The factory evaluates nothing.",
  trial: "The factory evaluates each pull request and shows whether it would merge or why it hands over, but never merges.",
  auto: "The factory merges a pull request it is confident about. Until auto-merge ships, this behaves like trial.",
};

function RepoRow({ repo, policy }: RepoMerging) {
  const router = useRouter();
  const [autonomy, setAutonomy] = useState<Autonomy>(policy.autonomy);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = `merging-${repo.replace(/\W/g, "-")}`;

  const change = (value: string) => {
    const next = autonomySchema.parse(value);
    const before = autonomy;
    setAutonomy(next);
    setFailure(null);
    startTransition(async () => {
      const outcome = await saveRepoAutonomy({ repo, autonomy: next });
      if (!outcome.ok) {
        setAutonomy(before);
        setFailure(outcome.message);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Field>
      <FieldLabel htmlFor={id} className="font-mono text-xs">
        {repo}
        {pending && <Spinner className="size-3" />}
      </FieldLabel>
      <Select value={autonomy} onValueChange={change} disabled={pending}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AUTONOMY_LEVELS.map((level) => (
            <SelectItem key={level} value={level}>
              {AUTONOMY_LABELS[level]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {AUTONOMY_HELP[autonomy]}
        {autonomy !== "off" && ` At most ${policy.maxChangedLines} changed lines, and none in ${policy.protectedPaths.length} protected paths.`}
      </FieldDescription>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </Field>
  );
}

export function MergingSettings({ repos }: { repos: readonly RepoMerging[] }) {
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Merging</CardTitle>
        <CardDescription>
          How far the factory may merge its own pull requests, per repo. A run merges only when the agent is confident and every hard
          limit holds: checks green, Bugbot clear, first attempt, within budget, small, and no protected paths.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {repos.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repo is known yet. Repos show here once a runner reports them or a job runs in one.</p>
        ) : (
          <FieldGroup>
            {repos.map((r) => (
              <RepoRow key={r.repo} {...r} />
            ))}
          </FieldGroup>
        )}
      </CardContent>
    </Card>
  );
}
