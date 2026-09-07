import { describe, expect, it, vi, beforeEach } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));

const mockIsMqttConfigured = vi.fn();
vi.mock("@/utils/mqtt/client", () => ({
  isMqttConfigured: () => mockIsMqttConfigured(),
}));

const mockPublishUnread = vi.fn();
vi.mock("@/utils/mqtt/events", () => ({
  publishUnread: (...args: unknown[]) => mockPublishUnread(...args),
}));

const mockGetInboxStatsForChatContext = vi.fn();
vi.mock("@/utils/ai/assistant/get-inbox-stats-for-chat-context", () => ({
  getInboxStatsForChatContext: (...args: unknown[]) =>
    mockGetInboxStatsForChatContext(...args),
}));

import { publishUnreadStats } from "./route";

const logger = createScopedLogger("test");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("publishUnreadStats", () => {
  /**
   * This is the entry point for the whole mail-processing pipeline and it
   * runs against up to 100 accounts per tick, inside the same try/catch that
   * counts an account as queued. A rejection here must never escape — that
   * would double-count the account as both queued and failed, logged under
   * the misleading "Failed to enqueue email account for processing" label.
   */
  it("does not throw when publishUnread rejects, so the account stays queued rather than also being marked failed", async () => {
    mockIsMqttConfigured.mockReturnValue(true);
    mockGetInboxStatsForChatContext.mockResolvedValue({
      unread: 3,
      total: 10,
    });
    mockPublishUnread.mockRejectedValue(new Error("broker unreachable"));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Mirrors the real call site's own try/catch: only a rejection here would
    // trip it and double-count the account as failed.
    let threw = false;
    try {
      await publishUnreadStats({
        emailAccountId: "a1",
        provider: "google",
        logger,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  /**
   * The gate exists to avoid an expensive provider API call per account when
   * nothing on the instance can consume it.
   */
  it("does not call getInboxStatsForChatContext when MQTT isn't configured", async () => {
    mockIsMqttConfigured.mockReturnValue(false);

    await publishUnreadStats({
      emailAccountId: "a1",
      provider: "google",
      logger,
    });

    expect(mockGetInboxStatsForChatContext).not.toHaveBeenCalled();
    expect(mockPublishUnread).not.toHaveBeenCalled();
  });
});
