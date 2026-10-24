import { linear } from "./linear";
import type { JobSource, SourceAdapter } from "./types";

export const SOURCES: { [S in JobSource]: SourceAdapter<S> } = { linear };

export const sourceFor = <S extends JobSource>(source: S): SourceAdapter<S> => SOURCES[source];

export const isJobSource = (name: string): name is JobSource => Object.hasOwn(SOURCES, name);
