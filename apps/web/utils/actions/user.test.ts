import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { deleteEmailAccountAction } from "@/utils/actions/user";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "user@example.com" },
  }),
  betterAuthConfig: {},
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn().mockResolvedValue({}) }));

const { mockClearAccountTopics } = vi.hoisted(() => ({
  mockClearAccountTopics: vi.fn(),
}));
vi.mock("@/utils/mqtt/events", () => ({
  clearAccountTopics: mockClearAccountTopics,
}));

const nonPrimaryAccount = {
  email: "secondary@example.com",
  accountId: "account-1",
  mqttTopicSlug: "acct-1-slug",
  user: { email: "primary@example.com" },
};

beforeEach(() => {
  vi.clearAllMocks();
  prisma.account.delete.mockResolvedValue({} as any);
});

describe("deleteEmailAccountAction", () => {
  /**
   * Retained MQTT topics outlive the account that published them (see
   * clearAccountTopics in utils/mqtt/events.ts). Deletion is a stronger
   * opt-out than the settings toggle, so it must clear them too — otherwise a
   * departed user's unread count, last-matched rule name, and (if they had
   * mqttIncludeDetail on) subject and sender stay retained on the shared
   * broker forever.
   */
  it("clears the account's MQTT topics using the slug captured before deletion", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(nonPrimaryAccount as any);

    const result = await deleteEmailAccountAction({
      emailAccountId: "email-account-1",
    });

    expect(result?.serverError).toBeUndefined();
    expect(mockClearAccountTopics).toHaveBeenCalledTimes(1);
    expect(mockClearAccountTopics).toHaveBeenCalledWith("acct-1-slug");
    // Clearing has to use the slug from before prisma.account.delete ran.
    expect(prisma.account.delete).toHaveBeenCalled();
  });

  it("does not call clearAccountTopics when the account never had a slug", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      ...nonPrimaryAccount,
      mqttTopicSlug: null,
    } as any);

    await deleteEmailAccountAction({ emailAccountId: "email-account-1" });

    expect(mockClearAccountTopics).not.toHaveBeenCalled();
  });
});
