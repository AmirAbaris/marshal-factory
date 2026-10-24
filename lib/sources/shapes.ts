import { z } from "zod";

export const JOB_SOURCES = ["linear"] as const;
export type JobSource = (typeof JOB_SOURCES)[number];

const linear = {
  label: "Linear",
  writeback: z.object({ kind: z.literal("linear"), issueId: z.string().min(1) }),
  sourceState: z.object({
    state: z.string().nullable(),
    labels: z.array(z.string()),
    /** Every comment the factory posted on the issue; anything else on it is a human. */
    factoryCommentIds: z.array(z.string()).default([]),
  }),
};

export const SOURCE_SHAPES = { linear } satisfies {
  [S in JobSource]: { label: string; writeback: z.ZodType; sourceState: z.ZodType };
};

export type WritebackOf<S extends JobSource> = z.infer<(typeof SOURCE_SHAPES)[S]["writeback"]>;
export type SourceStateOf<S extends JobSource> = z.output<(typeof SOURCE_SHAPES)[S]["sourceState"]>;
export type SourceStateDraftOf<S extends JobSource> = z.input<(typeof SOURCE_SHAPES)[S]["sourceState"]>;

export type JobId<S extends JobSource = JobSource> = `${S}:${string}`;

export const jobId = <S extends JobSource>(source: S, externalId: string): JobId<S> => `${source}:${externalId}`;

export function parseJobId(value: string): { id: JobId; source: JobSource; externalId: string } {
  const colon = value.indexOf(":");
  const source = value.slice(0, colon);
  if (colon < 1 || !(JOB_SOURCES as readonly string[]).includes(source)) throw new Error(`not a job id: ${value}`);
  return { id: value as JobId, source: source as JobSource, externalId: value.slice(colon + 1) };
}

export const sourceLink = (job: { source: JobSource; url: string }) => ({ label: SOURCE_SHAPES[job.source].label, href: job.url });
