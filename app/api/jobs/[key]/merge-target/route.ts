import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { github } from "@/lib/github/pulls";
import { parseJobKey } from "@/lib/live-queries";
import { mergeTarget } from "@/lib/merge";

/** What the merge dialog shows. A read, so a route and not a server action, which Next runs one at a time. */
export async function GET(_request: Request, { params }: RouteContext<"/api/jobs/[key]/merge-target">) {
  const key = parseJobKey((await params).key);
  if (!key) return Response.json({ error: "invalid job key" }, { status: 400 });
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.key, key));
  if (!job) return Response.json({ target: null }, { status: 404 });
  // Null for a non-owner as for a job with nothing to merge, so the route says nothing about either.
  const target = await mergeTarget({ db, pulls: github, user: async () => (await auth.getSession()).data?.user }, job.id);
  return Response.json({ target }, { headers: { "Cache-Control": "no-store" } });
}
