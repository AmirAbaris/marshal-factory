import { connection } from "next/server";
import { Suspense } from "react";
import { Repositories } from "@/components/panel/repositories";
import { db } from "@/db/client";
import { load, machinesQuery } from "@/lib/live-queries";
import { REPO_NAME } from "@/lib/repo-name";
import { readRegistry, readRepoStats } from "@/lib/repositories";

async function Panel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  // load checks the owner before anything is read.
  const machines = await load(machinesQuery());
  const [registry, stats, { repo }] = await Promise.all([readRegistry(db), readRepoStats(db), searchParams]);
  const selected = typeof repo === "string" && REPO_NAME.test(repo) ? repo : undefined;
  return <Repositories registry={registry} stats={stats} machines={machines} selected={selected} />;
}

export default function RepositoriesPage(props: PageProps<"/repositories">) {
  return (
    <Suspense fallback={<div className="h-full" />}>
      <Panel searchParams={props.searchParams} />
    </Suspense>
  );
}
