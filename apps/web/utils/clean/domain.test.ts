import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { CleanAction } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { createCleanupJob, listCleanupJobs } from "@/utils/clean/domain";
import { verifyPreviewToken } from "@/utils/clean/preview-token";

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({ after: vi.fn((fn: () => unknown) => fn()) }));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/email/provider-types", () => ({
  isGoogleProvider: vi.fn(() => true),
}));
vi.mock("@/utils/user/get", () => ({
  getUserPremium: vi.fn(async () => ({ id: "p1" })),
}));
vi.mock("@/utils/premium", () => ({ isActivePremium: vi.fn(() => true) }));
vi.mock("@/utils/upstash", () => ({
  bulkPublishToQstash: vi.fn(async () => undefined),
}));
vi.mock("@/utils/assess", () => ({
  getUnhandledCount: vi.fn(async () => ({ type: "inbox" })),
}));

import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getUserPremium } from "@/utils/user/get";
import { isActivePremium } from "@/utils/premium";

const userId = "user_1";
const emailAccountId = "ea_1";
const testLogger = createScopedLogger("test:cleanup");

function defaultSkips() {
  return {
    reply: true,
    starred: true,
    calendar: true,
    receipt: false,
    attachment: false,
    conversation: false,
  };
}

function buildProvider(threadCount: number) {
  return {
    getOrCreateInboxZeroLabel: vi.fn(async () => ({ id: "lbl_1", name: "x" })),
    getThreadsWithQuery: vi.fn(async () => ({
      threads: Array.from({ length: threadCount }, (_, i) => ({ id: `t${i}` })),
      nextPageToken: null,
    })),
  };
}

describe("listCleanupJobs", () => {
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

describe("createCleanupJob", () => {
  beforeEach(() => {
    vi.mocked(isGoogleProvider).mockReturnValue(true);
    vi.mocked(isActivePremium).mockReturnValue(true);
    vi.mocked(getUserPremium).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(createEmailProvider).mockResolvedValue(buildProvider(3) as never);
  });

  it("dry-run: returns matched count + previewToken without writing a CleanupJob row", async () => {
    const result = await createCleanupJob(
      { userId, emailAccountId, provider: "google", logger: testLogger },
      {
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: "",
        skips: defaultSkips(),
        confirm: false,
      },
    );

    expect(result.dryRun).toBe(true);
    if (!result.dryRun) throw new Error("expected dry-run");
    expect(result.preview.matchedCount).toBe(3);
    expect(result.preview.previewToken).toBeTruthy();
    const payload = verifyPreviewToken(
      result.preview.previewToken,
      emailAccountId,
    );
    expect(payload?.matchedCount).toBe(3);
    expect(prisma.cleanupJob.create).not.toHaveBeenCalled();
  });

  it("commit: creates a CleanupJob row when confirm=true", async () => {
    prisma.cleanupJob.create.mockResolvedValue({
      id: "new_job",
    } as never);

    const result = await createCleanupJob(
      { userId, emailAccountId, provider: "google", logger: testLogger },
      {
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: "",
        skips: defaultSkips(),
        confirm: true,
      },
    );

    expect(result.dryRun).toBe(false);
    if (result.dryRun) throw new Error("expected commit");
    expect(result.data.jobId).toBe("new_job");
    expect(prisma.cleanupJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailAccountId,
          action: CleanAction.ARCHIVE,
          daysOld: 7,
        }),
      }),
    );
  });

  it("commit with previewToken: throws StaleStateError on >10% drift", async () => {
    // First dry-run with 3 threads.
    const dry = await createCleanupJob(
      { userId, emailAccountId, provider: "google", logger: testLogger },
      {
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: "",
        skips: defaultSkips(),
        confirm: false,
      },
    );
    if (!dry.dryRun) throw new Error("expected dry-run");

    // Re-mock provider to return 100 threads — massive drift.
    vi.mocked(createEmailProvider).mockResolvedValueOnce(
      buildProvider(100) as never,
    );

    await expect(
      createCleanupJob(
        { userId, emailAccountId, provider: "google", logger: testLogger },
        {
          action: CleanAction.ARCHIVE,
          daysOld: 7,
          instructions: "",
          skips: defaultSkips(),
          confirm: true,
          previewToken: dry.preview.previewToken,
        },
      ),
    ).rejects.toThrow(/STALE_STATE/);
    expect(prisma.cleanupJob.create).not.toHaveBeenCalled();
  });

  it("commit with previewToken: passes when drift is within 10%", async () => {
    // Dry-run with 100 threads.
    vi.mocked(createEmailProvider).mockResolvedValueOnce(
      buildProvider(100) as never,
    );
    const dry = await createCleanupJob(
      { userId, emailAccountId, provider: "google", logger: testLogger },
      {
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: "",
        skips: defaultSkips(),
        confirm: false,
      },
    );
    if (!dry.dryRun) throw new Error("expected dry-run");

    // Commit with 105 (5% drift).
    vi.mocked(createEmailProvider).mockResolvedValueOnce(
      buildProvider(105) as never,
    );
    prisma.cleanupJob.create.mockResolvedValue({ id: "new_job" } as never);

    const commit = await createCleanupJob(
      { userId, emailAccountId, provider: "google", logger: testLogger },
      {
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: "",
        skips: defaultSkips(),
        confirm: true,
        previewToken: dry.preview.previewToken,
      },
    );
    expect(commit.dryRun).toBe(false);
  });

  it("commit with invalid previewToken: throws ValidationError", async () => {
    await expect(
      createCleanupJob(
        { userId, emailAccountId, provider: "google", logger: testLogger },
        {
          action: CleanAction.ARCHIVE,
          daysOld: 7,
          instructions: "",
          skips: defaultSkips(),
          confirm: true,
          previewToken: "garbage.token",
        },
      ),
    ).rejects.toThrow(/Invalid previewToken/);
  });

  it("non-Google provider: throws ConflictError", async () => {
    vi.mocked(isGoogleProvider).mockReturnValue(false);
    await expect(
      createCleanupJob(
        { userId, emailAccountId, provider: "microsoft", logger: testLogger },
        {
          action: CleanAction.ARCHIVE,
          daysOld: 7,
          instructions: "",
          skips: defaultSkips(),
          confirm: false,
        },
      ),
    ).rejects.toThrow(/Google/);
  });

  it("non-premium: throws ForbiddenError", async () => {
    vi.mocked(isActivePremium).mockReturnValue(false);
    await expect(
      createCleanupJob(
        { userId, emailAccountId, provider: "google", logger: testLogger },
        {
          action: CleanAction.ARCHIVE,
          daysOld: 7,
          instructions: "",
          skips: defaultSkips(),
          confirm: false,
        },
      ),
    ).rejects.toThrow(/premium/i);
  });
});
