import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, jobScreenshots } from "@/db/schema";
import { parseAssessment } from "@/lib/assessment";
import { parseJobKey } from "@/lib/live-queries";

/** One screenshot of the job's current assessment, by its place in the list; the proxy lets only the owner through. */
export async function GET(request: Request, { params }: RouteContext<"/api/jobs/[key]/screenshots/[index]">) {
  const { key: rawKey, index } = await params;
  const key = parseJobKey(rawKey);
  if (!key || !/^\d+$/.test(index)) return Response.json({ error: "invalid screenshot" }, { status: 400 });
  const [job] = await db.select({ reportId: jobs.assessment_event_id, assessment: jobs.merge_assessment }).from(jobs).where(eq(jobs.key, key));
  const ref = parseAssessment(job?.assessment)?.screenshots?.[Number(index)];
  // `v` names the report the URL was made for; a newer report's images get new URLs.
  if (!job?.reportId || !ref || new URL(request.url).searchParams.get("v") !== job.reportId) return Response.json({ error: "no such screenshot" }, { status: 404 });
  const [shot] = await db
    .select({ bytes: jobScreenshots.bytes, contentType: jobScreenshots.content_type })
    .from(jobScreenshots)
    .where(and(eq(jobScreenshots.stage_event_id, job.reportId), eq(jobScreenshots.file, ref.file)));
  if (!shot) return Response.json({ error: "the screenshot hasn't arrived" }, { status: 404 });
  // The URL names the report it belongs to, so the same URL always means the same image.
  return new Response(new Uint8Array(shot.bytes), { headers: { "Content-Type": shot.contentType, "Cache-Control": "private, max-age=31536000, immutable" } });
}
