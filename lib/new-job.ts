import { isOwner, type SessionUser } from "@/lib/auth/owner";
import type { Harness } from "@/lib/harness";
import { JOB_IMAGE_TYPES, MAX_JOB_IMAGE_BYTES, newJobSchema, type ImageUploadOutcome, type NewJobOutcome } from "@/lib/new-job-schema";
import type { FileDraft, FiledJob, ImageFile } from "@/lib/sources/types";
import { HARNESS_GROUP, RUNS_ON_GROUP, RUNS_ON_LABELS } from "@/lib/ticket-overrides";

// A job started from the panel is filed in its source like any other: for Linear, a Todo issue with
// the factory label that the webhook brings to the runner. Questions, stops and write-back then
// work as they do for an issue filed by hand. A harness or execution chosen in the form goes on the
// issue as the same override label a person would add.

export type NewJobDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  file: (draft: FileDraft) => Promise<FiledJob>;
  /** What the machines report; null when none has reported its harnesses yet. */
  harnesses: () => Promise<Harness[] | null>;
};

export async function createJob(deps: NewJobDeps, input: unknown): Promise<NewJobOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can start jobs." };
  const parsed = newJobSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The job is not valid." };
  const { provider, execution, ...draft } = parsed.data;
  const labels: NonNullable<FileDraft["labels"]> = [];
  if (provider) {
    const harness = (await deps.harnesses())?.find((h) => h.id === provider && h.enabled);
    if (!harness) return { ok: false, status: 400, message: `No machine reports an enabled harness ${provider}.` };
    labels.push({ group: HARNESS_GROUP, name: harness.name });
  }
  if (execution) labels.push({ group: RUNS_ON_GROUP, name: RUNS_ON_LABELS[execution] });
  try {
    const filed = await deps.file({ ...draft, ...(labels.length > 0 && { labels }) });
    return { ok: true, identifier: filed.key, url: filed.url };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not file the job: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export type ImageUploadDeps = {
  user: () => Promise<SessionUser | null | undefined>;
  upload: (image: ImageFile) => Promise<string>;
};

/** Stores an image for a job the owner is about to file; the form puts the returned markdown in the description. */
export async function uploadJobImage(deps: ImageUploadDeps, file: File | null): Promise<ImageUploadOutcome> {
  if (!isOwner(await deps.user())) return { ok: false, status: 403, message: "Only the factory owner can add images." };
  if (!file) return { ok: false, status: 400, message: "No image was sent." };
  if (!(JOB_IMAGE_TYPES as readonly string[]).includes(file.type)) return { ok: false, status: 400, message: `${file.name} is not a PNG, JPEG, WebP or GIF image.` };
  if (file.size > MAX_JOB_IMAGE_BYTES) return { ok: false, status: 413, message: `${file.name} is larger than 4 MB.` };
  try {
    const markdown = await deps.upload({ filename: file.name, contentType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    return { ok: true, markdown };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not upload ${file.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
