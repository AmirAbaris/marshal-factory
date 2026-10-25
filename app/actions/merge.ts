"use server";

import { db } from "@/db/client";
import { auth } from "@/lib/auth/server";
import { github } from "@/lib/github/pulls";
import { mergeJob as merge, type MergeDeps } from "@/lib/merge";
import type { JobId } from "@/lib/sources/shapes";

const deps: MergeDeps = {
  db,
  user: async () => (await auth.getSession()).data?.user,
  pulls: github,
};

export async function mergeJob(jobId: JobId, expectedHeadSha: string) {
  return merge(deps, jobId, expectedHeadSha);
}
