import { loadConfig } from "../lib/config";

/** The runner's config, loaded once; regressions adjust limits on this object. */
export const config = loadConfig();
