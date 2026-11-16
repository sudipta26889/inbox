import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { getEmailAccount } from "@/utils/redis/account-validation";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));

describe("getEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
  });

  it("grants a shared user access and reports the owner to act as", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "mailbox@example.com",
      userId: "owner",
    } as never);

    const access = await getEmailAccount({
      userId: "shared-user",
      emailAccountId: "acct-1",
    });

    expect(access).toEqual({
      email: "mailbox@example.com",
      ownerUserId: "owner",
    });
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: {
        id: "acct-1",
        OR: [
          { userId: "shared-user" },
          { shares: { some: { userId: "shared-user" } } },
        ],
      },
      select: { email: true, userId: true },
    });
  });

  it("denies a user who neither owns nor was shared the account, and caches the denial", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const access = await getEmailAccount({
      userId: "stranger",
      emailAccountId: "acct-1",
    });

    expect(access).toBeNull();
    expect(redis.set).toHaveBeenCalledWith(
      "account-access:stranger:acct-1",
      "none",
      { ex: 3600 },
    );
  });

  it("serves a cached denial without hitting the database", async () => {
    vi.mocked(redis.get).mockResolvedValue("none");

    expect(
      await getEmailAccount({ userId: "stranger", emailAccountId: "acct-1" }),
    ).toBeNull();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });
});
