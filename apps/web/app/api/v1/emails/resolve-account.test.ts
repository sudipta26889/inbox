import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { resolveUserAccount } from "@/app/api/v1/emails/resolve-account";

vi.mock("@/utils/prisma");

describe("resolveUserAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only finds accounts the user owns or has been shared", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "acc-2",
      account: { provider: "google" },
    } as never);

    const result = await resolveUserAccount({
      userId: "user-1",
      requestedAccountId: "acc-2",
    });

    expect(result).toEqual({ emailAccountId: "acc-2", provider: "google" });
    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "acc-2",
          OR: [{ userId: "user-1" }, { shares: { some: { userId: "user-1" } } }],
        },
      }),
    );
  });

  it("returns null for an account the user cannot access", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);

    await expect(
      resolveUserAccount({ userId: "user-1", requestedAccountId: "other" }),
    ).resolves.toBeNull();
  });
});
