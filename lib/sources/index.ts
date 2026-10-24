import type { JobRow } from "../../db/schema";
import { linear } from "./linear";
import { jobId, SOURCE_SHAPES } from "./shapes";
import type { Job, JobSource, SourceAdapter } from "./types";

export { jobId } from "./shapes";

export const SOURCES: { [S in JobSource]: SourceAdapter<S> } = { linear };

export const sourceFor = <S extends JobSource>(source: S): SourceAdapter<S> => SOURCES[source];

export const isJobSource = (name: string): name is JobSource => Object.hasOwn(SOURCES, name);

/** Where jobs rows enter the code: the source's schemas parse what only the source understands. */
export function parseJob(row: JobRow): Job {
  const shapes = SOURCE_SHAPES[row.source];
  const id = jobId(row.source, row.external_id);
  if (row.id !== id) throw new Error(`jobs row ${row.id} should have id ${id}`);
  return {
    ...row,
    id,
    writeback: shapes.writeback.parse(row.writeback),
    source_state: shapes.sourceState.parse(row.source_state),
  };
}

export const parseJobs = (rows: readonly JobRow[]) => rows.map(parseJob);
