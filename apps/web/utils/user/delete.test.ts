import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { deleteUser } from "./delete";

vi.mock("@/utils/prisma");
vi.mock("@inbox/loops", () => ({
  deleteContact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@inbox/resend", () => ({
  deleteContact: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@inbox/tinybird-ai-analytics", () => ({
  deleteTinybirdAiCalls: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/posthog", () => ({
  deletePosthogUser: vi.fn().mockResolvedValue(undefined),
  trackUserDeleted: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/error", () => ({
  captureException: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@/utils/email/watch-manager", () => ({
  unwatchEmails: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/utils/redis/research-cache", () => ({
  clearCachedResearchForUser: vi.fn().mockResolvedValue(undefined),
}));

const { mockClearAccountTopics } = vi.hoisted(() => ({
  mockClearAccountTopics: vi.fn(),
}));
vi.mock("@/utils/mqtt/events", () => ({
  clearAccountTopics: mockClearAccountTopics,
}));

const logger = createScopedLogger("test");

function mockAccount({
  emailAccountId = "email-account-1",
  mqttTopicSlug = null as string | null,
}: {
  emailAccountId?: string;
  mqttTopicSlug?: string | null;
} = {}) {
  return {
    provider: "google",
    access_token: null,
    refresh_token: null,
    expires_at: null,
    emailAccount: {
      id: emailAccountId,
      email: "user@example.com",
      watchEmailsSubscriptionId: null,
      mqttTopicSlug,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.executedRule.findMany.mockResolvedValue([]);
  prisma.user.delete.mockResolvedValue({} as any);
});

describe("deleteUser", () => {
  /**
   * Retained MQTT topics outlive the account that published them (see
   * clearAccountTopics in utils/mqtt/events.ts). Deleting the whole user is a
   * stronger opt-out than the settings toggle, so it must clear them too —
   * otherwise a departed user's slug keeps a retained unread count, last
   * matched rule name, and (with mqttIncludeDetail on) a subject and sender
   * address, readable by anything with the broker password.
   */
  it("clears MQTT topics for every email account's slug", async () => {
    prisma.account.findMany.mockResolvedValue([
      mockAccount({ mqttTopicSlug: "acct-1-slug" }),
    ] as any);

    await deleteUser({ userId: "user-1", logger });

    expect(mockClearAccountTopics).toHaveBeenCalledTimes(1);
    expect(mockClearAccountTopics).toHaveBeenCalledWith("acct-1-slug");
  });

  it("does not call clearAccountTopics for an account that never had a slug", async () => {
    prisma.account.findMany.mockResolvedValue([
      mockAccount({ mqttTopicSlug: null }),
    ] as any);

    await deleteUser({ userId: "user-1", logger });

    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });

  it("clears topics for each linked email account's own slug", async () => {
    prisma.account.findMany.mockResolvedValue([
      mockAccount({ emailAccountId: "email-account-1", mqttTopicSlug: "one" }),
      mockAccount({ emailAccountId: "email-account-2", mqttTopicSlug: "two" }),
    ] as any);

    await deleteUser({ userId: "user-1", logger });

    expect(mockClearAccountTopics).toHaveBeenCalledWith("one");
    expect(mockClearAccountTopics).toHaveBeenCalledWith("two");
  });
});
