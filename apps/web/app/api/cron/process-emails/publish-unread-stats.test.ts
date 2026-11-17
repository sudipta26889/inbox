import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { publishUnreadStats } from "./publish-unread-stats";

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
});
