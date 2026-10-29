import { connection } from "next/server";
import { Suspense } from "react";
import { SettingsForm } from "@/components/panel/settings-form";
import { FormSkeleton, PageSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { load, machinesQuery } from "@/lib/live-queries";
import { readNotifications } from "@/lib/notifications";
import { readSettings } from "@/lib/settings";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // load checks the owner before anything is read.
  const machines = await load(machinesQuery());
  const [saved, notifications] = await Promise.all([readSettings(db), readNotifications(db)]);
  return <SettingsForm machines={machines} saved={saved} notifications={notifications} />;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Settings"><FormSkeleton /></PageSkeleton>}>
      <Panel />
    </Suspense>
  );
}
