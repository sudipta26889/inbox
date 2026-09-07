import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessagingProvider } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockNotifyOwner, mockSendAutomationMessage } = vi.hoisted(() => ({
  mockNotifyOwner: vi.fn().mockResolvedValue(undefined),
  mockSendAutomationMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/ntfy", () => ({ notifyOwner: mockNotifyOwner }));
vi.mock("@/utils/automation-jobs/messaging", () => ({
  sendAutomationMessage: mockSendAutomationMessage,
}));

import { alertDigestFailure } from "@/utils/a2a/digest-report";

const logger = createScopedLogger("test");

describe("alertDigestFailure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockNotifyOwner.mockResolvedValue(undefined);
    mockSendAutomationMessage.mockResolvedValue(undefined);
  });

  it("pushes to ntfy even when no messaging channel is connected", async () => {
    // The whole reason this call exists: ntfy needs no per-user channel
    // setup, unlike the Telegram path below it that gives up here.
    prisma.messagingChannel.findFirst.mockResolvedValue(null);

    await alertDigestFailure({
      userId: "user-1",
      outcome: {
        status: "failed",
        date: "2026-09-07",
        at: "2026-09-07T05:00:00.000Z",
        error: "boom",
      },
      logger,
    });

    expect(mockNotifyOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Morning digest failed",
        message: "2026-09-07: boom",
      }),
    );
    expect(mockSendAutomationMessage).not.toHaveBeenCalled();
  });

  it("still sends the Telegram-style alert too, when a channel is connected", async () => {
    prisma.messagingChannel.findFirst.mockResolvedValue({
      provider: MessagingProvider.TELEGRAM,
      accessToken: "token",
      providerUserId: "chat-1",
      channelId: null,
      isConnected: true,
    } as any);

    await alertDigestFailure({
      userId: "user-1",
      outcome: {
        status: "failed",
        date: "2026-09-07",
        at: "2026-09-07T05:00:00.000Z",
        error: "boom",
      },
      logger,
    });

    expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    expect(mockSendAutomationMessage).toHaveBeenCalledTimes(1);
  });
});
