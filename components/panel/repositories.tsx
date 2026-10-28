"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { makeDefaultRepository, saveRepository } from "@/app/actions/repositories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { MachineRow, RepoSettingsRow } from "@/db/schema";
import { EXECUTIONS, type Execution } from "@/lib/execution";
import type { Harness } from "@/lib/harness";
import { parseInventory, rebuildText, reportedDrift, reportedHarnesses, reportedSandbox, UNKNOWN } from "@/lib/machine";
import { AUTONOMY_LABELS, AUTONOMY_LEVELS, DEFAULT_POLICY, type Autonomy } from "@/lib/merge-decision";
import { repoImage } from "@/lib/onboarding";
import { displayName } from "@/lib/repo-name";
import type { RepoStats } from "@/lib/repositories";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";
import { cn } from "@/lib/utils";
import { useRowKeys } from "./row-keys";
import { useFeed, type Feed } from "./sealed";
import { PanelFooter, PanelHeader, type KeyHint } from "./panel-header";
import { AddRepository, OnboardingBadge, OnboardingSection, onboardingLine, useOnboardingRefresh } from "./repo-onboarding";
import { ShortTime, useNow } from "./time";

const CLOCK_TICK_MS = 30_000;

const AUTONOMY_HELP: Record<Autonomy, string> = {
  off: "Every pull request is ready for your review. The factory evaluates nothing.",
  trial: "The factory evaluates each pull request and shows whether it would merge or why it hands over, but never merges.",
  auto: "The factory merges a pull request it is confident about and every hard limit holds: checks green, Bugbot clear, first attempt, small, and no protected paths.",
};

const LIST_KEYS: readonly KeyHint[] = [
  { keys: ["J", "K"], label: "move" },
  { keys: ["↵"], label: "open" },
  { keys: ["Esc"], label: "close" },
];

const SETTINGS_DEFAULT = "settings-default";

const itemHref = (repo: string) => `/repositories?${new URLSearchParams({ repo })}`;
const githubUrl = (repo: string) => `https://github.com/${repo}`;

/**
 * Where a repo's jobs can launch. Modal needs a runner that can launch there and, for an onboarded
 * repo, its warm image, or the base image while the warm one is outdated; a local launch needs a
 * runner's checkout.
 */
export type Places = { modal: boolean; modalNote: string | null; machines: string[]; rebuild?: string };

function placesOf(rows: readonly MachineRow[], now: number, row: RepoSettingsRow): Places {
  const sandbox = reportedSandbox(rows, now);
  const drift = sandbox ? reportedDrift(sandbox) : [];
  const runner = Boolean(sandbox && sandbox.modal && sandbox.image && drift.length === 0 && sandbox.codexSlots > 0);
  const info = sandbox?.imageInfo;
  const image = repoImage(row, info?.versions ? { versions: info.versions, builtAt: info.builtAt } : null);
  const machines = rows.filter((m) => parseInventory(m.inventory)?.repos.some((r) => r.origin !== UNKNOWN && r.origin === row.repo)).map((m) => m.name);
  const modalNote = (() => {
    switch (image.kind) {
      case "warm":
        return "Warm cloud sandbox image ready";
      case "base":
        return image.outdated ? "Cloud sandboxes start from the base image until the warm one is rebuilt" : "Cloud sandbox image ready";
      case "blocked":
        return null;
      default: {
        const never: never = image;
        throw new Error(`unknown image ${String(never)}`);
      }
    }
  })();
  return { modal: runner && image.kind !== "blocked", modalNote, machines, ...(drift.length > 0 && { rebuild: rebuildText(drift) }) };
}

function placesLine({ modal, modalNote, machines, rebuild }: Places) {
  const parts = [modal && modalNote, rebuild, machines.length > 0 && `Local checkout on ${machines.join(", ")}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Neither a cloud sandbox image nor a local checkout";
}

type Entry = { row: RepoSettingsRow; stats: RepoStats | undefined; places: Places };

function Row({ entry, open, cursor, onFocus }: { entry: Entry; open: boolean; cursor: boolean; onFocus: () => void }) {
  const { row, stats, places } = entry;
  const nowhere = !places.modal && places.machines.length === 0;
  return (
    <div
      className={cn(
        "relative flex h-9 w-full items-center gap-3 px-4 transition-colors duration-150 hover:bg-accent/60 @3xl:px-5",
        open ? "bg-accent" : cursor && "bg-accent/60",
        !row.enabled && "text-muted-foreground",
      )}
    >
      <Link
        href={itemHref(row.repo)}
        scroll={false}
        data-row={row.repo}
        onFocus={onFocus}
        aria-current={open ? "true" : undefined}
        aria-label={`Open ${displayName(row)}`}
        className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      />
      {cursor && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground" />}
      <span className={cn("size-2 shrink-0 rounded-full", row.enabled ? "bg-success" : "bg-muted-foreground/50")} title={row.enabled ? "Takes new jobs" : "Disabled"} />
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="truncate font-medium">{displayName(row)}</span>
        {row.is_default && (
          <Badge variant="secondary" size="sm">
            Default
          </Badge>
        )}
        {!row.enabled && (
          <Badge variant="outline" size="sm">
            Disabled
          </Badge>
        )}
        {row.onboarding_state && <OnboardingBadge state={row.onboarding_state} />}
        <a
          href={githubUrl(row.repo)}
          target="_blank"
          rel="noreferrer"
          className="relative hidden min-w-0 items-center gap-1 truncate font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline @lg:flex"
        >
          {row.repo}
          <ExternalLinkIcon className="size-3 shrink-0" />
        </a>
      </span>
      <span className="hidden w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums @md:block">{stats?.open ?? 0} open</span>
      <span className="hidden w-12 shrink-0 text-right text-xs text-muted-foreground tabular-nums @md:block">
        {stats?.lastAt ? <ShortTime date={stats.lastAt} /> : "none"}
      </span>
      <span
        className={cn(
          "hidden w-72 shrink-0 truncate text-xs @3xl:block",
          nowhere || row.onboarding_state === "failed" || row.onboarding_state === "needs_input" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {row.onboarding_state && row.onboarding_state !== "ready" ? onboardingLine(row) : placesLine(places)}
      </span>
      <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground @2xl:block">Merging · {AUTONOMY_LABELS[row.autonomy]}</span>
    </div>
  );
}

const linesOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function Detail({ entry, harnesses, panelTakesSecrets }: { entry: Entry; harnesses: readonly Harness[]; panelTakesSecrets: boolean }) {
  const router = useRouter();
  const { row, stats, places } = entry;
  const [name, setName] = useState(displayName(row));
  const [enabled, setEnabled] = useState(row.enabled);
  const [provider, setProvider] = useState(row.provider ?? SETTINGS_DEFAULT);
  const [execution, setExecution] = useState<Execution | typeof SETTINGS_DEFAULT>(row.execution ?? SETTINGS_DEFAULT);
  const [autonomy, setAutonomy] = useState<Autonomy>(row.autonomy);
  const [paths, setPaths] = useState((row.protected_paths ?? []).join("\n"));
  const [limit, setLimit] = useState(row.max_changed_lines === null ? "" : String(row.max_changed_lines));
  const [requireBugbot, setRequireBugbot] = useState(row.require_bugbot);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = (field: string) => `repo-${field}`;

  const harnessItems = [
    { value: SETTINGS_DEFAULT, label: "Settings default" },
    ...harnesses.map((h) => ({ value: h.id, label: h.name })),
    // A default harness no machine reports enabled any more still shows, so saving keeps it.
    ...(row.provider && !harnesses.some((h) => h.id === row.provider) ? [{ value: row.provider, label: `${row.provider} (not reported by any runner)` }] : []),
  ];
  const runsOnItems = [{ value: SETTINGS_DEFAULT, label: "Settings default" }, ...EXECUTIONS.map((e) => ({ value: e, label: RUNS_ON_LABELS[e] }))];
  const autonomyItems = AUTONOMY_LEVELS.map((level) => ({ value: level, label: AUTONOMY_LABELS[level] }));

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setFailure(null);
    setSavedNow(false);
    startTransition(async () => {
      const outcome = await action();
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setSavedNow(true);
      router.refresh();
    });
  };

  const save = () => {
    const lines = Number(limit);
    run(() =>
      saveRepository({
        repo: row.repo,
        displayName: name,
        enabled,
        provider: provider === SETTINGS_DEFAULT ? null : provider,
        execution: execution === SETTINGS_DEFAULT ? null : execution,
        autonomy,
        protectedPaths: linesOf(paths).length > 0 ? linesOf(paths) : null,
        maxChangedLines: limit.trim() === "" ? null : lines,
        requireBugbot,
      }),
    );
  };

  return (
    <aside aria-label={`${displayName(row)} details`} className="flex min-h-0 flex-col border-l bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 px-4.5 py-4">
          <div className="flex items-center justify-between font-mono text-xs text-faint">
            <span>{row.repo}</span>
            <Button render={<Link href="/repositories" scroll={false} />} variant="ghost" size="icon-sm" aria-label="Close">
              <XIcon />
            </Button>
          </div>
          <h2 className="text-base font-semibold">{displayName(row)}</h2>
          <div className="flex flex-wrap items-center gap-2">
            {row.is_default ? (
              <Badge variant="secondary">Default</Badge>
            ) : (
              <Button variant="outline" size="sm" disabled={pending || !row.enabled} onClick={() => run(() => makeDefaultRepository({ repo: row.repo }))}>
                Make default
              </Button>
            )}
            <span className="text-muted-foreground">
              {stats?.open ?? 0} open {stats?.open === 1 ? "job" : "jobs"}
            </span>
            <Button render={<a href={githubUrl(row.repo)} target="_blank" rel="noreferrer" />} variant="outline" size="sm" className="ml-auto">
              GitHub
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
          </div>
          <p className={cn("text-sm", !places.modal && places.machines.length === 0 ? "text-warning" : "text-muted-foreground")}>{placesLine(places)}</p>
        </div>
        <Separator />
        <OnboardingSection key={`${row.onboarding_state}-${row.onboarding_at?.toISOString()}`} row={row} panelTakesSecrets={panelTakesSecrets} />
        <Separator />
        <div className="flex flex-col gap-5 px-4.5 py-4">
          <Field>
            <FieldLabel htmlFor={id("name")}>Display name</FieldLabel>
            <Input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} />
            <FieldDescription>Also the name of its child in the Repository label group in Linear. Run the label sync after a rename.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("enabled")}>New jobs</FieldLabel>
            <Select
              items={[
                { value: "enabled", label: "Takes new jobs" },
                { value: "disabled", label: "Disabled" },
              ]}
              value={enabled ? "enabled" : "disabled"}
              onValueChange={(value) => value !== null && setEnabled(value === "enabled")}
              disabled={row.is_default}
            >
              <SelectTrigger id={id("enabled")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="enabled">Takes new jobs</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectPopup>
            </Select>
            <FieldDescription>
              {row.is_default
                ? "The default repository always takes new jobs."
                : "A disabled repository takes no new jobs; an issue labeled with it goes to the default, and the issue is told why."}
            </FieldDescription>
          </Field>
          <div className="grid w-full grid-cols-2 gap-4">
            <Field>
              <FieldLabel htmlFor={id("harness")}>Default harness</FieldLabel>
              <Select items={harnessItems} value={provider} onValueChange={(value) => value !== null && setProvider(value)}>
                <SelectTrigger id={id("harness")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {harnessItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={id("runs-on")}>Default runs on</FieldLabel>
              <Select
                items={runsOnItems}
                value={execution}
                onValueChange={(value) => value !== null && setExecution(value === SETTINGS_DEFAULT ? SETTINGS_DEFAULT : (value as Execution))}
              >
                <SelectTrigger id={id("runs-on")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {runsOnItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <p className="col-span-2 text-sm text-muted-foreground">
              A ticket&apos;s Harness or Runs on label beats these, and these beat Settings. A local run needs a runner&apos;s checkout of the repo;
              without one the job runs in a cloud sandbox, or waits until it can.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor={id("autonomy")}>Merging</FieldLabel>
            <Select items={autonomyItems} value={autonomy} onValueChange={(value) => value !== null && setAutonomy(value)}>
              <SelectTrigger id={id("autonomy")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {autonomyItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>{AUTONOMY_HELP[autonomy]}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("paths")}>Protected paths</FieldLabel>
            <Textarea
              id={id("paths")}
              value={paths}
              onChange={(e) => setPaths(e.target.value)}
              rows={5}
              placeholder={DEFAULT_POLICY.protectedPaths.join("\n")}
              className="font-mono text-xs"
            />
            <FieldDescription>One glob per line. A pull request touching any of them never merges on its own. Empty means the defaults shown.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("limit")}>Size limit</FieldLabel>
            <Input
              id={id("limit")}
              type="number"
              inputMode="numeric"
              min={1}
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              placeholder={String(DEFAULT_POLICY.maxChangedLines)}
            />
            <FieldDescription>The most changed lines, additions plus deletions, a pull request may have to merge on its own. Empty means {DEFAULT_POLICY.maxChangedLines}.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>
              <Switch checked={requireBugbot} onCheckedChange={setRequireBugbot} />
              Require Bugbot review
            </FieldLabel>
            <FieldDescription>
              A pull request waits for Bugbot&apos;s review and doesn&apos;t merge on its own with an unresolved medium or high finding. Turn it off for a repo without Bugbot, so the factory neither waits for its review nor reads its findings.
            </FieldDescription>
          </Field>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center gap-3 border-t px-4.5 py-3.5">
        <Button onClick={save} disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          Save
        </Button>
        {savedNow && !pending && <span className="text-sm text-muted-foreground">Saved. New jobs use it.</span>}
      </div>
    </aside>
  );
}

/** Every repository in the registry as one dense row; Enter opens its settings on the right. */
export function Repositories({
  registry,
  stats,
  machines,
  selected,
  panelTakesSecrets,
}: {
  registry: readonly RepoSettingsRow[];
  stats: readonly RepoStats[];
  machines: Feed<MachineRow>;
  selected: string | undefined;
  /** The panel holds a Modal token, so it takes secret values itself. */
  panelTakesSecrets: boolean;
}) {
  useOnboardingRefresh(registry);
  const { rows, status } = useFeed(machines, "/api/live/machines");
  const now = useNow(CLOCK_TICK_MS) ?? 0;
  const harnesses = useMemo(() => (reportedHarnesses(rows, now) ?? []).filter((h) => h.enabled), [rows, now]);
  const entries = useMemo(
    () => registry.map((row): Entry => ({ row, stats: stats.find((s) => s.repo === row.repo), places: placesOf(rows, now, row) })),
    [registry, stats, rows, now],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(selected ?? null);
  useRowKeys(listRef, { cursor, setCursor, hrefOf: itemHref, closeHref: selected ? "/repositories" : null });
  const open = entries.find((e) => e.row.repo === selected);
  const enabledCount = registry.filter((r) => r.enabled).length;

  return (
    <>
      <PanelHeader title="Repositories" actions={<AddRepository />} />
      {entries.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No repository is registered yet</EmptyTitle>
              <EmptyDescription>
                Add one the GitHub App can reach, or start a runner: it registers the checkouts in its config, and the first one becomes the default.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className={cn("grid min-h-0 flex-1", open ? "grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_520px]" : "grid-cols-1")}>
          <div ref={listRef} className="@container min-h-0 min-w-0 overflow-y-auto">
            <ul aria-label="Repositories">
              {entries.map((entry) => (
                <li key={entry.row.repo} className="border-b">
                  <Row entry={entry} open={entry === open} cursor={cursor === entry.row.repo} onFocus={() => setCursor(entry.row.repo)} />
                </li>
              ))}
            </ul>
          </div>
          {open && <Detail key={open.row.repo} entry={open} harnesses={harnesses} panelTakesSecrets={panelTakesSecrets} />}
        </div>
      )}
      <PanelFooter
        status={status}
        summary={`${registry.length} ${registry.length === 1 ? "repository" : "repositories"}, ${enabledCount} taking new jobs`}
        keys={LIST_KEYS}
      />
    </>
  );
}
