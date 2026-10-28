export type JobView = "board" | "list";

/** The last view the owner picked, so `/` without `?view` opens it. */
export const JOB_VIEW_COOKIE = "jobs_view";

export const parseJobView = (raw: unknown): JobView | undefined => (raw === "board" || raw === "list" ? raw : undefined);

/**
 * The jobs page in `view`, with the run open on the right when there is one. `archived` shows the
 * archive, always as a list, and leaves the view out so the remembered one comes back after it.
 */
export const jobsHref = (view: JobView, run?: string, archived = false) =>
  `/?${new URLSearchParams({ ...(!archived && { view }), ...(run && { run }), ...(archived && { archived: "1" }) })}`;
