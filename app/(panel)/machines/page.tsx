import { connection } from "next/server";
import { Suspense } from "react";
import { Machines } from "@/components/panel/machines";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { load, machinesQuery } from "@/lib/live-queries";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  const machines = await load(machinesQuery());
  return <Machines machines={machines} />;
}

export default function MachinesPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Machines"><RowsSkeleton rows={3} /></PageSkeleton>}>
      <Panel />
    </Suspense>
  );
}
