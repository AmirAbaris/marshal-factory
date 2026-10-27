"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, useEffect, useMemo, useOptimistic } from "react";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { JobRow, RepoSettingsRow } from "@/db/schema";
import { ALL_REPOS, REPO_FILTER_COOKIE } from "@/lib/repo-filter";
import { displayName, repoName } from "@/lib/repo-name";

/** A repo the filter offers: every registered one, and any other a loaded job ran in. */
export type RepoOption = { repo: string; name: string; jobs: number };

export function repoOptions(registry: readonly Pick<RepoSettingsRow, "repo" | "display_name">[], jobs: readonly Pick<JobRow, "repo">[]): RepoOption[] {
  const count = (repo: string) => jobs.filter((j) => j.repo === repo).length;
  const registered = registry.map((r) => ({ repo: r.repo, name: displayName(r), jobs: count(r.repo) }));
  const others = [...new Set(jobs.map((j) => j.repo))].filter((repo) => !registry.some((r) => r.repo === repo)).map((repo) => ({ repo, name: repoName(repo), jobs: count(repo) }));
  return [...registered, ...others].sort((a, b) => a.name.localeCompare(b.name));
}

const remember = (repo: string | null) => {
  document.cookie = `${REPO_FILTER_COOKIE}=${repo ?? ALL_REPOS}; path=/; max-age=${60 * 60 * 24 * 365}`;
};

/**
 * The repo the jobs page and the inbox show; null shows all. A pick is remembered in the cookie
 * and written to `?repo`, and the page stays mounted, so the live feeds stay subscribed. A repo
 * opened by link is remembered too, so links without `?repo`, such as a run's, keep showing it.
 */
export function useRepoFilter(current: string | null) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [repo, setOptimistic] = useOptimistic(current);
  useEffect(() => remember(current), [current]);
  const pick = (next: string | null) => {
    remember(next);
    const params = new URLSearchParams(searchParams);
    if (next) params.set("repo", next);
    else params.delete("repo");
    const query = params.toString();
    startTransition(() => {
      setOptimistic(next);
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    });
  };
  return [repo, pick] as const;
}

/** The short name a card or row shows for its repo; undefined while only one repo has jobs, so nothing shows. */
export function useRepoLabels(options: readonly RepoOption[]) {
  return useMemo(() => {
    const used = options.filter((o) => o.jobs > 0);
    return used.length > 1 ? new Map(used.map((o) => [o.repo, o.name])) : undefined;
  }, [options]);
}

export function RepoSelect({ options, value, onChange }: { options: readonly RepoOption[]; value: string | null; onChange: (repo: string | null) => void }) {
  const total = options.reduce((sum, o) => sum + o.jobs, 0);
  const items = [{ value: ALL_REPOS, label: "All repositories", jobs: total }, ...options.map((o) => ({ value: o.repo, label: o.name, jobs: o.jobs }))];
  return (
    <Select items={items} value={value ?? ALL_REPOS} onValueChange={(next) => next !== null && onChange(next === ALL_REPOS ? null : next)}>
      <SelectTrigger size="sm" aria-label="Repository" className="w-auto max-w-48 shrink-0">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            <span className="flex w-full items-center justify-between gap-3">
              {item.label}
              <span className="text-xs text-muted-foreground tabular-nums">{item.jobs}</span>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
