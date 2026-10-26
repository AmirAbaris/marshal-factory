import { connection } from "next/server";
import { Suspense } from "react";
import { RealtimeRoot } from "@/components/panel/realtime-root";
import { SettingsForm } from "@/components/panel/settings-form";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { load, machinesQuery } from "@/lib/live-queries";
import { parseInventory, UNKNOWN } from "@/lib/machine";
import { readRepoSettings, readSettings, resolvePolicy } from "@/lib/settings";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // load checks the owner before anything is read.
  const machines = await load(machinesQuery());
  const [saved, repoRows, jobRepos] = await Promise.all([readSettings(db), readRepoSettings(db), db.selectDistinct({ repo: jobs.repo }).from(jobs)]);
  const inventoryRepos = machines.initialData.flatMap((m) => parseInventory(m.inventory)?.repos ?? []).flatMap((r) => (r.origin === UNKNOWN ? [] : [r.origin]));
  const repos = [...new Set([...inventoryRepos, ...jobRepos.map((r) => r.repo), ...repoRows.map((r) => r.repo)])].sort();
  return (
    <RealtimeRoot>
      <SettingsForm machines={machines} saved={saved} merging={repos.map((repo) => ({ repo, policy: resolvePolicy(repoRows, repo) }))} />
    </RealtimeRoot>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <Panel />
    </Suspense>
  );
}
