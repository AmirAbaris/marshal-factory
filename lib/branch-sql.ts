import { sql, type SQL } from "drizzle-orm";
import { jobs } from "../db/schema";

/** attemptBranch (lib/factory.ts) in SQL, for the job row a query is on. */
export const attemptBranchSql: SQL<string> = sql<string>`case when ${jobs.attempt} > 1 then 'factory/' || ${jobs.key} || '-a' || ${jobs.attempt} else 'factory/' || ${jobs.key} end`;
