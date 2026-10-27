"use server";

import { createJob as create } from "@/lib/new-job";
import { newJobDeps } from "@/lib/new-job-deps";
import type { NewJob } from "@/lib/new-job-schema";

export async function createJob(input: NewJob) {
  return create(newJobDeps, input);
}
