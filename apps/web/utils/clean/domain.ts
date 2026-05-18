import prisma from "@/utils/prisma";
import type { CleanAction } from "@/generated/prisma/enums";

export type DomainCtx = { userId: string; emailAccountId: string };

export type ListCleanupJobsInput = { limit?: number };

export type CleanupJobSummary = {
  id: string;
  action: CleanAction;
  daysOld: number;
  instructions: string | null;
  threadCount: number;
  createdAt: Date;
  updatedAt: Date;
};

export async function listCleanupJobs(
  ctx: DomainCtx,
  input: ListCleanupJobsInput,
): Promise<{ jobs: CleanupJobSummary[]; total: number }> {
  const take = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const rows = await prisma.cleanupJob.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      action: true,
      daysOld: true,
      instructions: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { threads: true } },
    },
  });

  const total = await prisma.cleanupJob.count({
    where: { emailAccountId: ctx.emailAccountId },
  });

  return {
    jobs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      daysOld: r.daysOld,
      instructions: r.instructions,
      threadCount: r._count.threads,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    total,
  };
}
