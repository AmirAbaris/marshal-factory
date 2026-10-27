"use server";

import { auth } from "@/lib/auth/server";
import {
  answerQuestion as answer,
  approveFromRunDetail as approveInRunDetail,
  approveMerge as approve,
  closeJob as close,
  dismissJob as dismiss,
  fileFollowUp as followUp,
  intentOutcome as outcome,
  requestChanges as changes,
  retryStop as retry,
} from "@/lib/inbox-actions";
import { inboxDeps } from "@/lib/inbox-deps";
import type { JobId } from "@/lib/sources/shapes";

const deps = inboxDeps(async () => (await auth.getSession()).data?.user);

export async function approveMerge(jobId: JobId, requestId: string, headSha: string | null) {
  return approve(deps, jobId, requestId, headSha);
}

export async function approveFromRunDetail(jobId: JobId, requestId: string, headSha: string) {
  return approveInRunDetail(deps, jobId, requestId, headSha);
}

export async function requestChanges(jobId: JobId, requestId: string, body: string) {
  return changes(deps, jobId, requestId, body);
}

export async function fileFollowUp(jobId: JobId, requestId: string, body: string) {
  return followUp(deps, jobId, requestId, body);
}

export async function answerQuestion(jobId: JobId, requestId: string, body: string) {
  return answer(deps, jobId, requestId, body);
}

export async function closeJob(jobId: JobId, requestId: string, reason: string) {
  return close(deps, jobId, requestId, reason);
}

export async function retryStop(jobId: JobId, requestId: string) {
  return retry(deps, jobId, requestId);
}

export async function dismissJob(jobId: JobId) {
  return dismiss(deps, jobId);
}

export async function inboxIntentOutcome(intentId: string) {
  return outcome(deps, intentId);
}
