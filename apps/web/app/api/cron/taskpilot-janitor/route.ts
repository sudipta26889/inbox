import { NextResponse } from "next/server";
import { hasCronSecret } from "@/utils/cron";
import { sweepStaleRunningDecisions } from "@/utils/taskpilot/janitor";
import { withError } from "@/utils/middleware";

/**
 * TaskPilot Janitor Cron Job
 *
 * Cleans up stale RUNNING TaskpilotDecision rows that have exceeded the 60-second
 * threshold, marking them as LLM_FAILED to unblock future routing.
 *
 * Recommended schedule: every 5 minutes (cron: *\/5 * * * *)
 */

export const POST = withError(async (request: Request) => {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sweepStaleRunningDecisions();
  return NextResponse.json(result);
});
