import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs } from "@/db/schema";
import { auth } from "@/lib/auth/server";
import { github } from "@/lib/github/pulls";
import { inboxReview } from "@/lib/inbox-actions";
import { parseJobKey } from "@/lib/live-queries";

/** The changed files and Bugbot's findings an inbox item shows. A read, so a route and not a server action. */
export async function GET(_request: Request, { params }: RouteContext<"/api/jobs/[key]/review">) {
  const key = parseJobKey((await params).key);
  if (!key) return Response.json({ error: "invalid job key" }, { status: 400 });
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.key, key));
  if (!job) return Response.json({ review: null }, { status: 404 });
  try {
    const review = await inboxReview({ db, pulls: github, user: async () => (await auth.getSession()).data?.user }, job.id);
    return Response.json({ review }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ review: null, error: `GitHub could not be read: ${error instanceof Error ? error.message : String(error)}` }, { status: 502 });
  }
}
