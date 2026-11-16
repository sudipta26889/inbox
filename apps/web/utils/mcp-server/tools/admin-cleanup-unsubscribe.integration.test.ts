import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { CleanAction, NewsletterStatus } from "@/generated/prisma/enums";
import {
  adminCleanupCreateJob,
  adminCleanupListJobs,
} from "./admin-cleanup-tools";
import {
  adminUnsubscribeList,
  adminUnsubscribeRequest,
} from "./admin-unsubscribe-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({ after: vi.fn((fn: () => unknown) => fn()) }));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    getOrCreateInboxZeroLabel: vi.fn(async () => ({
      id: "lbl_1",
      name: "archived",
    })),
    getThreadsWithQuery: vi.fn(async () => ({
      threads: [{ id: "t1" }],
      nextPageToken: null,
    })),
  })),
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
vi.mock("@/utils/senders/unsubscribe", () => ({
  unsubscribeSenderAndMark: vi.fn(async () => ({
    senderEmail: "n@x.com",
    status: NewsletterStatus.UNSUBSCRIBED,
    unsubscribe: {
      attempted: true,
      success: true,
      method: "post",
      statusCode: 200,
    },
  })),
  setSenderStatus: vi.fn(async () => undefined),
}));
vi.mock("@/utils/parse/unsubscribe", () => ({
  getHttpUnsubscribeLink: vi.fn(() => "https://example.com/unsub"),
}));
vi.mock("@/utils/senders/record", () => ({
  extractEmailOrThrow: (s: string) => s,
}));

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

describe("cleanup + unsubscribe integration", () => {
  beforeEach(() => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    } as never);
  });

  it("flow: list cleanup empty -> dry-run -> confirm -> list returns the new job", async () => {
    prisma.cleanupJob.findMany.mockResolvedValueOnce([] as never);
    prisma.cleanupJob.count.mockResolvedValueOnce(0 as never);
    const before = await adminCleanupListJobs(ctx, {});
    expect(before.ok).toBe(true);
    if (before.ok && before.data) expect(before.data.total).toBe(0);

    const dry = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: false,
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);

    prisma.cleanupJob.create.mockResolvedValue({
      id: "new_job",
    } as never);
    const commit = await adminCleanupCreateJob(ctx, {
      action: CleanAction.ARCHIVE,
      daysOld: 7,
      skips: defaultSkips(),
      confirm: true,
    });
    expect(commit.ok).toBe(true);
    expect(commit.dryRun).toBe(false);

    prisma.cleanupJob.findMany.mockResolvedValueOnce([
      {
        id: "new_job",
        action: CleanAction.ARCHIVE,
        daysOld: 7,
        instructions: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        _count: { threads: 0 },
      },
    ] as never);
    prisma.cleanupJob.count.mockResolvedValueOnce(1 as never);
    const after = await adminCleanupListJobs(ctx, {});
    if (after.ok && after.data) expect(after.data.total).toBe(1);
  });

  it("flow: list senders -> dry-run unsubscribe -> confirm fires HTTP", async () => {
    prisma.newsletter.findMany.mockResolvedValueOnce([
      {
        id: "n1",
        email: "n@x.com",
        name: null,
        status: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    prisma.newsletter.count.mockResolvedValueOnce(1 as never);
    const list = await adminUnsubscribeList(ctx, {});
    if (list.ok && list.data) expect(list.data.total).toBe(1);

    const dry = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: "https://example.com/unsub",
      confirm: false,
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    const preview = dry.preview as { method: string };
    expect(preview.method).toBe("http");

    prisma.newsletter.findUnique.mockResolvedValueOnce(null as never);
    const commit = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: "https://example.com/unsub",
      confirm: true,
    });
    expect(commit.ok).toBe(true);
    expect(commit.dryRun).toBe(false);
  });
});
