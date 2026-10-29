import type { JobRow } from "@/db/schema";
import type { MergeAssessment } from "@/lib/assessment";
import { screenshotUrl } from "@/lib/screenshots";

/** What the agent saw in the browser, as it attached it to its assessment; each opens full size in a new tab. */
export function Screenshots({ job, assessment }: { job: Pick<JobRow, "key" | "stage_event_id">; assessment: MergeAssessment }) {
  const shots = assessment.screenshots ?? [];
  if (shots.length === 0) return null;
  return (
    <ul className="grid grid-cols-2 gap-2">
      {shots.map((shot, i) => {
        const src = screenshotUrl(job.key, i, job.stage_event_id);
        return (
          <li key={`${i}:${shot.file}`} className="flex min-w-0 flex-col gap-1">
            <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-muted">
              {/* An owner-only image behind the session; next/image would fetch it without the cookie. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={shot.caption} loading="lazy" className="aspect-video w-full object-cover object-top" />
            </a>
            <span className="text-xs text-muted-foreground">{shot.caption}</span>
          </li>
        );
      })}
    </ul>
  );
}
