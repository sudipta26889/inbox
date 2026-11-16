import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { createScopedLogger } from "@/utils/logger";
import { GET, publishUnreadStats } from "./route";

const { CRON_SECRET, mockEnv } = vi.hoisted(() => ({
  CRON_SECRET: "cron-secret",
  mockEnv: {} as Record<string, unknown>,
}));

const { mockIsMqttConfigured, mockPublishUnread, mockGetInboxStats } =
  vi.hoisted(() => ({
    mockIsMqttConfigured: vi.fn(),
    mockPublishUnread: vi.fn(),
    mockGetInboxStats: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/mqtt/client", () => ({
  isMqttConfigured: mockIsMqttConfigured,
}));
vi.mock("@/utils/mqtt/events", () => ({ publishUnread: mockPublishUnread }));
vi.mock("@/utils/ai/assistant/get-inbox-stats-for-chat-context", () => ({
  getInboxStatsForChatContext: mockGetInboxStats,
}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: vi.fn().mockResolvedValue("internal-fallback"),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  Object.assign(mockEnv, actual.env, { CRON_SECRET });
  return { env: mockEnv };
});

describe("GET /api/cron/process-emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;
  });

  it("enqueues every connected mailbox when billing is bypassed", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "ea-1" },
      { id: "ea-2" },
    ] as never);

    const response = await GET(
      new NextRequest("http://web:5500/api/cron/process-emails", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 2, queued: 2, failed: 0 });
    const { where } = prisma.emailAccount.findMany.mock.calls[0][0]!;
    expect(where).toEqual({
      account: {
        disconnectedAt: null,
        provider: { in: ["google", "microsoft"] },
      },
    });
    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { emailAccountId: "ea-2" },
        qstash: expect.objectContaining({ path: "/api/process-emails" }),
      }),
    );
  });

  it("keeps the premium filter, so an image built without the bypass enqueues nothing", async () => {
    mockEnv.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = undefined;
    prisma.emailAccount.findMany.mockResolvedValue([] as never);

    const response = await GET(
      new NextRequest("http://web:5500/api/cron/process-emails", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(await response.json()).toEqual({ total: 0, queued: 0, failed: 0 });
    const { where } = prisma.emailAccount.findMany.mock.calls[0][0]!;
    expect(where).toHaveProperty("user.premium");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});

describe("publishUnreadStats", () => {
  const logger = createScopedLogger("test");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Runs inside the per-account try/catch that counts an account as queued:
  // a rejection here would double-count it as both queued and failed.
  it("does not throw when publishUnread rejects", async () => {
    mockIsMqttConfigured.mockReturnValue(true);
    mockGetInboxStats.mockResolvedValue({ unread: 3, total: 10 });
    mockPublishUnread.mockRejectedValue(new Error("broker unreachable"));

    await expect(
      publishUnreadStats({ emailAccountId: "a1", provider: "google", logger }),
    ).resolves.toBeUndefined();
    expect(mockPublishUnread).toHaveBeenCalledWith({
      emailAccountId: "a1",
      unread: 3,
      total: 10,
    });
  });

  // The gate avoids a provider API call per account when nothing on the
  // instance can consume it.
  it("does not read inbox stats when MQTT isn't configured", async () => {
    mockIsMqttConfigured.mockReturnValue(false);

    await publishUnreadStats({
      emailAccountId: "a1",
      provider: "google",
      logger,
    });

    expect(mockGetInboxStats).not.toHaveBeenCalled();
    expect(mockPublishUnread).not.toHaveBeenCalled();
  });

  it("publishes each queued mailbox's unread count from the cron", async () => {
    mockEnv.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;
    mockIsMqttConfigured.mockReturnValue(true);
    mockGetInboxStats.mockResolvedValue({ unread: 1, total: 2 });
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "ea-1", account: { provider: "microsoft" } },
    ] as never);

    const response = await GET(
      new NextRequest("http://web:5500/api/cron/process-emails", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(await response.json()).toEqual({ total: 1, queued: 1, failed: 0 });
    expect(mockGetInboxStats).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "ea-1", provider: "microsoft" }),
    );
    expect(mockPublishUnread).toHaveBeenCalledWith({
      emailAccountId: "ea-1",
      unread: 1,
      total: 2,
    });
  });
});
