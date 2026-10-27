"use client";

import { ExternalLinkIcon, LockIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { addableRepositories, addRepository, rebuildRepositoryImage, retryOnboarding, saveRepositorySecrets } from "@/app/actions/repositories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { RepoSettingsRow } from "@/db/schema";
import { componentName, IMAGE_COMPONENTS } from "@/lib/machine";
import { parseDetail, STATE_LABELS, stateLine, type OnboardingState } from "@/lib/onboarding";
import { CHECKS, RECIPE_PATH } from "@/lib/recipe";
import type { AddableOutcome } from "@/lib/repo-onboarding";
import { cn } from "@/lib/utils";
import { ShortTime } from "./time";

const BADGE: Record<OnboardingState, "info" | "warning" | "success" | "error"> = {
  analyzing: "info",
  needs_input: "warning",
  building: "info",
  ready: "success",
  rebuilding: "info",
  failed: "error",
};

/** States a runner is working through; the page refreshes itself while any repo is in one. */
const MOVING: readonly OnboardingState[] = ["analyzing", "building", "rebuilding"];
const REFRESH_MS = 10_000;

export function OnboardingBadge({ state }: { state: OnboardingState }) {
  return (
    <Badge variant={BADGE[state]} size="sm">
      {MOVING.includes(state) && <Spinner className="size-2.5" />}
      {STATE_LABELS[state]}
    </Badge>
  );
}

export function useOnboardingRefresh(registry: readonly RepoSettingsRow[]) {
  const router = useRouter();
  const moving = registry.some((r) => r.onboarding_state && MOVING.includes(r.onboarding_state));
  useEffect(() => {
    if (!moving) return;
    const id = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(id);
  }, [moving, router]);
}

export const onboardingLine = (row: RepoSettingsRow) => (row.onboarding_state ? stateLine(row.onboarding_state, parseDetail(row.onboarding_detail)) : null);

type Addable = Extract<AddableOutcome, { ok: true }>;

/** Lists the repos the GitHub App reaches that are not registered, and adds the one picked. */
export function AddRepository() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [addable, setAddable] = useState<Addable | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState<string | null>(null);

  const load = () => {
    setFailure(null);
    setAddable(null);
    startTransition(async () => {
      const outcome = await addableRepositories();
      if (outcome.ok) setAddable(outcome);
      else setFailure(outcome.message);
    });
  };
  const add = (repo: string) => {
    setFailure(null);
    setAdding(repo);
    startTransition(async () => {
      const outcome = await addRepository({ repo });
      setAdding(null);
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      if (outcome.labelNote) setNote(outcome.labelNote);
      else setOpen(false);
      router.push(`/repositories?${new URLSearchParams({ repo })}`, { scroll: false });
      router.refresh();
    });
  };
  const shown = addable?.repos.filter((r) => r.repo.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending && adding) return;
        setOpen(next);
        if (next) {
          setNote(null);
          setFilter("");
          load();
        }
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <PlusIcon data-icon="inline-start" />
        Add repository
      </DialogTrigger>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add repository</DialogTitle>
          <DialogDescription>
            Pick a repository the factory&apos;s GitHub App can reach. An agent then writes its setup recipe as a pull request, and the factory builds a
            warm sandbox image from it so jobs start fast.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {note ? (
            <p className="text-sm text-warning">{note}</p>
          ) : (
            <>
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter repositories" aria-label="Filter repositories" autoFocus />
              <div className="max-h-80 min-h-24 overflow-y-auto rounded-md border">
                {!addable && !failure && (
                  <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
                    <Spinner data-icon="inline-start" />
                    Asking GitHub
                  </div>
                )}
                {addable && shown.length === 0 && (
                  <p className="p-4 text-sm text-muted-foreground">
                    {addable.repos.length === 0 ? "Every repository the app can reach is registered already." : "No repository matches."}
                  </p>
                )}
                <ul aria-label="Repositories the GitHub App can reach">
                  {shown.map((r) => (
                    <li key={r.repo} className="border-b last:border-b-0">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => add(r.repo)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/60 focus-visible:bg-accent focus-visible:outline-none disabled:opacity-64"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 font-mono text-sm">
                            {r.repo}
                            {r.private && <LockIcon className="size-3 text-muted-foreground" aria-label="Private" />}
                          </span>
                          {r.description && <span className="block truncate text-xs text-muted-foreground">{r.description}</span>}
                        </span>
                        {adding === r.repo && <Spinner />}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" render={<a href={addable?.manageUrl ?? "https://github.com/settings/installations"} target="_blank" rel="noreferrer" />}>
            Grant access to more repositories
            <ExternalLinkIcon data-icon="inline-end" />
          </Button>
          {note && <Button onClick={() => setOpen(false)}>Done</Button>}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Secrets({ row, panelTakesSecrets }: { row: RepoSettingsRow; panelTakesSecrets: boolean }) {
  const router = useRouter();
  const detail = parseDetail(row.onboarding_detail);
  const env = detail.recipe?.env ?? [];
  const set = new Set(detail.secretsSet ?? []);
  const [values, setValues] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (env.length === 0) return null;
  const save = () => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await saveRepositorySecrets({ repo: row.repo, values });
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setValues({});
      router.refresh();
    });
  };
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Secrets</h3>
      <p className="text-sm text-muted-foreground">
        Values go straight to the Modal secret every sandbox of this repo gets. The factory keeps only their names.
      </p>
      {env.map((e) => (
        <Field key={e.name}>
          <FieldLabel htmlFor={`secret-${e.name}`} className="font-mono text-xs">
            {e.name}
            {e.required ? "" : " (optional)"}
            {set.has(e.name) && (
              <Badge variant="success" size="sm">
                Set
              </Badge>
            )}
          </FieldLabel>
          {panelTakesSecrets ? (
            <Input
              id={`secret-${e.name}`}
              type="password"
              autoComplete="off"
              value={values[e.name] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [e.name]: event.target.value }))}
              placeholder={set.has(e.name) ? "Paste to replace" : "Paste the value"}
            />
          ) : (
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-xs">
              bun scripts/repo-secret.ts {row.repo} {e.name}
            </code>
          )}
          {e.purpose && <FieldDescription>{e.purpose}</FieldDescription>}
        </Field>
      ))}
      {!panelTakesSecrets && <p className="text-sm text-muted-foreground">This panel has no Modal token, so run each command on the runner Mac; it asks for the value without showing it.</p>}
      {panelTakesSecrets && (
        <div>
          <Button size="sm" onClick={save} disabled={pending || Object.values(values).every((v) => v.trim() === "")}>
            {pending && <Spinner data-icon="inline-start" />}
            Save secrets
          </Button>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}

/** Where onboarding stands, the recipe, the warm image and the secrets, with Retry and Rebuild. */
export function OnboardingSection({ row, panelTakesSecrets }: { row: RepoSettingsRow; panelTakesSecrets: boolean }) {
  const router = useRouter();
  const detail = parseDetail(row.onboarding_detail);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const state = row.onboarding_state;
  const act = (action: (input: { repo: string }) => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await action({ repo: row.repo });
      if (outcome.ok) router.refresh();
      else setFailure(outcome.message);
    });
  };
  const recipe = detail.recipe;
  const checks = recipe ? CHECKS.filter((name) => recipe.checks[name]) : [];
  const result = (name: string) => detail.checks?.find((c) => c.name === name);
  const versions = detail.image?.base.versions;

  return (
    <div className="flex flex-col gap-4 px-4.5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Onboarding</h3>
        {state ? <OnboardingBadge state={state} /> : <Badge variant="outline" size="sm">Not onboarded</Badge>}
      </div>
      <p className={cn("text-sm", state === "failed" || state === "needs_input" ? "text-warning" : "text-muted-foreground")}>
        {state ? stateLine(state, detail) : "Registered before onboarding. Its Modal jobs start from the base image and set themselves up."}
      </p>
      {detail.failure?.log && <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{detail.failure.log}</pre>}
      {detail.summary && <p className="text-sm">{detail.summary}</p>}
      {recipe && (
        <div className="flex flex-col gap-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">Recipe</span>
            <span className="font-mono text-xs">{RECIPE_PATH}</span>
            <span className="text-muted-foreground">{detail.recipeSource === "committed" ? "on main" : "from the onboarding agent"}</span>
            {detail.recipePr && (
              <a href={detail.recipePr} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                Recipe pull request
                <ExternalLinkIcon className="size-3" />
              </a>
            )}
          </div>
          {(recipe.system?.length ?? 0) > 0 && <p className="text-muted-foreground">System packages: {recipe.system!.join(", ")}</p>}
          <div>
            <p className="text-muted-foreground">Setup</p>
            <ul className="font-mono text-xs">
              {recipe.setup.map((cmd, i) => (
                <li key={i}>{cmd}</li>
              ))}
            </ul>
          </div>
          {checks.length > 0 && (
            <div>
              <p className="text-muted-foreground">Checks</p>
              <ul className="flex flex-col gap-0.5">
                {checks.map((name) => {
                  const r = result(name);
                  return (
                    <li key={name} className="flex items-center gap-2">
                      <span className="w-20 shrink-0 capitalize">{name}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{recipe.checks[name]}</span>
                      {r && (
                        <Badge variant={r.ok ? "success" : "error"} size="sm">
                          {r.ok ? "Passed" : (r.note ?? "Failed")}
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
      {detail.image && (
        <p className="text-sm text-muted-foreground">
          Warm image built <ShortTime date={new Date(detail.image.builtAt)} /> at <span className="font-mono text-xs">{detail.image.commit.slice(0, 7)}</span>
          {versions && ` · ${IMAGE_COMPONENTS.filter((c) => versions[c]).map((c) => `${componentName(c)} ${versions[c]}`).join(", ")}`}
        </p>
      )}
      <Secrets key={(detail.secretsSet ?? []).join(",")} row={row} panelTakesSecrets={panelTakesSecrets} />
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={pending || Boolean(detail.run)} onClick={() => act(retryOnboarding)}>
          {state ? "Retry onboarding" : "Onboard"}
        </Button>
        {recipe && (
          <Button variant="outline" size="sm" disabled={pending || state === "needs_input" || detail.run?.kind === "agent"} onClick={() => act(rebuildRepositoryImage)}>
            Rebuild image
          </Button>
        )}
      </div>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
