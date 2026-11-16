import prisma from "@/utils/prisma";

const STALE_THRESHOLD_MS = 60_000;

export async function sweepStaleRunningDecisions(): Promise<{ swept: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const r = await prisma.taskpilotDecision.updateMany({
    where: { status: "RUNNING", ranAt: { lt: cutoff } },
    data: {
      status: "LLM_FAILED",
      errorMsg: "janitor: stale RUNNING row reaped",
    },
  });
  return { swept: r.count };
}
