export type JobView = "board" | "list";

/** The last view the owner picked, so `/` without `?view` opens it. */
export const JOB_VIEW_COOKIE = "jobs_view";

export const parseJobView = (raw: unknown): JobView | undefined => (raw === "board" || raw === "list" ? raw : undefined);

/** The jobs page in `view`, with the run open on the right when there is one. */
export const jobsHref = (view: JobView, run?: string) => `/?${new URLSearchParams(run ? { view, run } : { view })}`;
