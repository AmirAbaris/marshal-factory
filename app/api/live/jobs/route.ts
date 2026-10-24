import { jobsQuery, sealedResponse } from "@/lib/live-queries";

export async function POST() {
  return sealedResponse(jobsQuery());
}
