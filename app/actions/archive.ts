"use server";

import { auth } from "@/lib/auth/server";
import { archiveJobs as archive, unarchiveJobs as unarchive } from "@/lib/archive-actions";
import { inboxDeps } from "@/lib/inbox-deps";
import type { JobId } from "@/lib/sources/shapes";

const deps = inboxDeps(async () => (await auth.getSession()).data?.user);

export async function archiveJobs(ids: JobId[]) {
  return archive(deps, ids);
}

export async function unarchiveJobs(ids: JobId[]) {
  return unarchive(deps, ids);
}
