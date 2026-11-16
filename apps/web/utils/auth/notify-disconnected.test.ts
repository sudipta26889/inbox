import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { notifyMailboxDisconnected } from "./notify-disconnected";
import {
  getRemoteAgentUrls,
  resolveA2aEndpoint,
  sendA2aMessage,
} from "@/utils/a2a-client";
import { redis } from "@/utils/redis";

vi.mock("@/utils/a2a-client", () => ({
  getRemoteAgentUrls: vi.fn(),
  resolveA2aEndpoint: vi.fn(),
  sendA2aMessage: vi.fn(),
}));
vi.mock("@/utils/redis", () => ({
  redis: { set: vi.fn(), del: vi.fn() },
}));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BASE_URL: "https://inbox.example.com" },
}));

const logger = createScopedLogger("test");

describe("notifyMailboxDisconnected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T04:30:00.000Z"));
    vi.mocked(getRemoteAgentUrls).mockReturnValue(["https://mitra.test"]);
    vi.mocked(resolveA2aEndpoint).mockResolvedValue("https://mitra.test/a2a");
    vi.mocked(sendA2aMessage).mockResolvedValue({} as any);
    vi.mocked(redis.set).mockResolvedValue("OK");
  });

  const params = {
    email: "decagames@example.com",
    emailAccountId: "ea_1",
    reason: "invalid_grant",
    logger,
  };

  it("sends one message with the expected kind, text and contextId", async () => {
    await notifyMailboxDisconnected(params);

    expect(redis.set).toHaveBeenCalledWith(
      "mailbox-disconnect-alert:ea_1",
      "1",
      { nx: true, ex: 43_200 },
    );
    expect(sendA2aMessage).toHaveBeenCalledTimes(1);
    expect(sendA2aMessage).toHaveBeenCalledWith("https://mitra.test/a2a", {
      text: "Inbox lost access to decagames@example.com (invalid_grant). Mail from it is not being processed. Reconnect: https://inbox.example.com/accounts",
      data: {
        kind: "inbox.mailbox_disconnected",
        email: "decagames@example.com",
        email_account_id: "ea_1",
        reason: "invalid_grant",
        at: "2026-11-16T04:30:00.000Z",
      },
      contextId: "inbox-disconnect-ea_1-2026-11-16",
    });
  });

  it("does not send a second alert within the dedupe window", async () => {
    vi.mocked(redis.set).mockResolvedValue(null);

    await notifyMailboxDisconnected(params);

    expect(sendA2aMessage).not.toHaveBeenCalled();
  });

  it("does nothing when no remote agents are configured", async () => {
    vi.mocked(getRemoteAgentUrls).mockReturnValue([]);

    await notifyMailboxDisconnected(params);

    expect(sendA2aMessage).not.toHaveBeenCalled();
  });

  it("logs and swallows a send error", async () => {
    vi.mocked(sendA2aMessage).mockRejectedValue(new Error("boom"));
    const errorSpy = vi.spyOn(logger, "error");

    await expect(notifyMailboxDisconnected(params)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });

  it("releases the dedupe key when every send was rejected", async () => {
    vi.mocked(sendA2aMessage).mockRejectedValue(new Error("boom"));

    await notifyMailboxDisconnected(params);

    expect(redis.del).toHaveBeenCalledWith("mailbox-disconnect-alert:ea_1");
  });

  it("keeps the dedupe key when a send succeeded", async () => {
    await notifyMailboxDisconnected(params);

    expect(redis.del).not.toHaveBeenCalled();
  });

  it("logs and swallows an A2A error result", async () => {
    vi.mocked(sendA2aMessage).mockResolvedValue({
      error: { message: "rejected" },
    } as any);
    const errorSpy = vi.spyOn(logger, "error");

    await expect(notifyMailboxDisconnected(params)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
  });
});
