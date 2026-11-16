import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { CleanAction } from "@/generated/prisma/enums";
import {
  adminCleanupCreateJob,
  adminCleanupListJobs,
} from "./admin-cleanup-tools";
import type { McpToolContext } from "./registry";

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

const ctx: McpToolContext = {
  clientId: "c1",
  userId: "user_1",
  emailAccountId: "ea_1",
  scopes: ["admin"],
};

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

describe("adminCleanupListJobs", () => {
  it("returns ok envelope with the job list scoped to the token's account", async () => {
    prisma.cleanupJob.findMany.mockResolvedValue([
      {
        id: "job_a",
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { threads: 0 },
      },
    ] as never);
    prisma.cleanupJob.count.mockResolvedValue(1 as never);

    const result = await adminCleanupListJobs(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.jobs).toHaveLength(1);
      expect(result.data.jobs[0].action).toBe(CleanAction.ARCHIVE);
      expect(result.data.total).toBe(1);
    }
  });

  it("returns VALIDATION_ERROR on bad input", async () => {
    const result = await adminCleanupListJobs(ctx, { limit: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminCleanupCreateJob", () => {
  beforeEach(() => {
    vi.mocked(createEmailProvider).mockResolvedValue(buildProvider(2) as never);
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    } as never);
  });

  it("dry-run returns preview and does not create a CleanupJob row", async () => {
    const result = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: false,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    const preview = result.preview as {
      matchedCount: number;
      previewToken: string;
    };
    expect(preview.matchedCount).toBe(2);
    expect(preview.previewToken).toBeTruthy();
    expect(prisma.cleanupJob.create).not.toHaveBeenCalled();
  });

  it("confirm:true creates the CleanupJob row", async () => {
    prisma.cleanupJob.create.mockResolvedValue({ id: "new_job" } as never);

    const result = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: true,
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(false);
    if (result.ok && result.data) {
      expect(result.data.jobId).toBe("new_job");
    }
    expect(prisma.cleanupJob.create).toHaveBeenCalled();
  });

  it("returns STALE_STATE when drift > 10% with a previewToken", async () => {
    const dry = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: false,
    });
    expect(dry.ok).toBe(true);
    const dryPreview = dry.preview as { previewToken: string };

    // Switch provider to return 100 threads for the next call.
    vi.mocked(createEmailProvider).mockResolvedValueOnce(
      buildProvider(100) as never,
    );

    const result = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: true,
      previewToken: dryPreview.previewToken,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_STATE");
    expect(prisma.cleanupJob.create).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR on bad input", async () => {
    const result = await adminCleanupCreateJob(ctx, {
      // missing action
      skips: defaultSkips(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
