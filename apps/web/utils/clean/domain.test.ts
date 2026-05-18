import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { CleanAction } from "@/generated/prisma/enums";
import { listCleanupJobs } from "@/utils/clean/domain";

vi.mock("@/utils/prisma");

describe("listCleanupJobs", () => {
  const userId = "user_1";
  const emailAccountId = "ea_1";

  it("returns jobs scoped to ctx.emailAccountId, newest first", async () => {
    const now = new Date("2026-05-01");
    const earlier = new Date("2026-04-01");
    prisma.cleanupJob.findMany.mockResolvedValue([
      {
        id: "job_a",
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: null,
        createdAt: now,
        updatedAt: now,
        _count: { threads: 0 },
      },
      {
        id: "job_b",
        action: CleanAction.MARK_READ,
        daysOld: 14,
        instructions: null,
        createdAt: earlier,
        updatedAt: earlier,
        _count: { threads: 0 },
      },
    ] as never);
    prisma.cleanupJob.count.mockResolvedValue(2 as never);

    const { jobs, total } = await listCleanupJobs(
      { userId, emailAccountId },
      {},
    );

    expect(total).toBe(2);
    expect(jobs).toHaveLength(2);
    expect(prisma.cleanupJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId },
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("includes the cleanup thread count per job", async () => {
    prisma.cleanupJob.findMany.mockResolvedValue([
      {
        id: "job_a",
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { threads: 5 },
      },
    ] as never);
    prisma.cleanupJob.count.mockResolvedValue(1 as never);

    const { jobs } = await listCleanupJobs({ userId, emailAccountId }, {});
    expect(jobs[0].threadCount).toBe(5);
  });

  it("respects the limit parameter (clamped to 1..200)", async () => {
    prisma.cleanupJob.findMany.mockResolvedValue([] as never);
    prisma.cleanupJob.count.mockResolvedValue(0 as never);

    await listCleanupJobs({ userId, emailAccountId }, { limit: 5 });
    expect(prisma.cleanupJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );

    await listCleanupJobs({ userId, emailAccountId }, { limit: 5000 });
    expect(prisma.cleanupJob.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it("scopes by emailAccountId in the where clause", async () => {
    prisma.cleanupJob.findMany.mockResolvedValue([] as never);
    prisma.cleanupJob.count.mockResolvedValue(0 as never);

    await listCleanupJobs({ userId, emailAccountId: "other_account" }, {});

    expect(prisma.cleanupJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "other_account" },
      }),
    );
    expect(prisma.cleanupJob.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "other_account" },
      }),
    );
  });
});
