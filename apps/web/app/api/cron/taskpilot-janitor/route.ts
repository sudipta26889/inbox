import { NextResponse } from "next/server";
import { hasCronSecret } from "@/utils/cron";
import { sweepStaleRunningDecisions } from "@/utils/taskpilot/janitor";
import { withError } from "@/utils/middleware";
import {
  backfillTaskpilotLinks,
  LINK_BACKFILL_DELAY_MS,
  LINK_BACKFILL_MAX_PER_RUN,
  LINK_BACKFILL_MAX_TOTAL,
} from "@/utils/taskpilot/link-backfill";

/**
 * TaskPilot Janitor Cron Job
 *
 * Cleans up stale RUNNING TaskpilotDecision rows that have exceeded the 60-second
 * threshold, marking them as LLM_FAILED to unblock future routing.
 *
 * Recommended schedule: every 5 minutes (cron: *\/5 * * * *)
 */

export const GET = withError("cron/taskpilot-janitor", async (request) => {
  if (!hasCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await sweepStaleRunningDecisions();

  // A backfill error must not fail the janitor sweep above.
  try {
    await backfillTaskpilotLinks({
      logger: request.logger,
      maxPerRun: LINK_BACKFILL_MAX_PER_RUN,
      maxTotal: LINK_BACKFILL_MAX_TOTAL,
      delayMs: LINK_BACKFILL_DELAY_MS,
    });
  } catch (error) {
    request.logger.error("TaskPilot link backfill failed", { error });
  }

  return NextResponse.json(result);
});

export const POST = GET;
