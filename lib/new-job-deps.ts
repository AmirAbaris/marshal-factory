import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { reportedHarnesses } from "@/lib/machine";
import { readRegistry } from "@/lib/repositories";
import type { NewJobDeps } from "@/lib/new-job";
import { panelSource } from "@/lib/sources";

/** How the panel files a job: in its source (lib/sources), as the signed-in owner, with the harnesses the machines report and the registered repos. */
export const newJobDeps: NewJobDeps = {
  user: async () => (await auth.getSession()).data?.user,
  file: (draft) => panelSource().file!(draft),
  harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
  registry: () => readRegistry(db),
};
