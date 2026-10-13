import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));

const { mockProcessHistoryItem, mockIsProcessed, mockRedis } = vi.hoisted(
  () => ({
    mockProcessHistoryItem: vi.fn().mockResolvedValue(undefined),
    mockIsProcessed: vi.fn(),
    mockRedis: { set: vi.fn() },
  }),
);
vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: mockProcessHistoryItem,
}));
vi.mock("@/utils/redis/outbound-thread-status", () => ({
  isOutboundThreadStatusProcessed: mockIsProcessed,
}));
vi.mock("@/utils/redis", () => ({ redis: mockRedis }));

import { processRecentSentMessages } from "./process-sent";

const logger = createScopedLogger("test");

describe("processRecentSentMessages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("processes each recent sent message once, skipping ones push already handled", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        messages: [
          { id: "done", threadId: "t1" },
          { id: "claimed", threadId: "t2" },
          { id: "new", threadId: "t3" },
        ],
      },
    });
    const gmail = { users: { messages: { list } } } as never;
    mockIsProcessed.mockImplementation(
      async ({ messageId }) => messageId === "done",
    );
    mockRedis.set.mockImplementation(async (key: string) =>
      key.endsWith(":new") ? "OK" : null,
    );

    const processed = await processRecentSentMessages({
      gmail,
      emailAccountId: "ea",
      options: {} as never,
      logger,
    });

    expect(list).toHaveBeenCalledWith({
      userId: "me",
      labelIds: ["SENT"],
      q: "newer_than:1d",
      maxResults: 50,
    });
    expect(processed).toBe(1);
    expect(mockProcessHistoryItem).toHaveBeenCalledTimes(1);
    expect(mockProcessHistoryItem).toHaveBeenCalledWith(
      { messageId: "new", threadId: "t3" },
      {},
    );
  });
});
