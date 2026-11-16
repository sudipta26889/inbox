import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));
vi.mock("@/utils/email/rate-limit", () => ({
  getEmailProviderRateLimitState: vi.fn(async () => null),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithAuthTestMiddleware();
});

import { GET } from "./route";

describe("GET /api/user/email-accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists owned and shared accounts, and hides who else a shared account is shared with", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      account({
        id: "owned",
        userId: "user-1",
        shares: [{ user: { id: "user-2", email: "b@x.com", name: null } }],
      }),
      account({
        id: "shared",
        userId: "owner-9",
        shares: [{ user: { id: "user-1", email: "a@x.com", name: null } }],
      }),
    ] as never);

    const response = await GET(
      new NextRequest("http://localhost/api/user/email-accounts"),
      {} as never,
    );
    const { emailAccounts } = await response.json();

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { userId: "user-1" },
            { shares: { some: { userId: "user-1" } } },
          ],
        },
      }),
    );
    expect(emailAccounts).toMatchObject([
      {
        id: "owned",
        isShared: false,
        sharedWith: [{ id: "user-2", email: "b@x.com", name: null }],
      },
      { id: "shared", isShared: true, isPrimary: false, sharedWith: [] },
    ]);
    expect(emailAccounts[0]).not.toHaveProperty("userId");
    expect(emailAccounts[1]).not.toHaveProperty("shares");
  });
});

function account({
  id,
  userId,
  shares,
}: {
  id: string;
  userId: string;
  shares: { user: { id: string; email: string; name: string | null } }[];
}) {
  return {
    id,
    userId,
    email: `${id}@x.com`,
    accountId: `acc-${id}`,
    name: id,
    image: null,
    includeInAllAccounts: true,
    account: { disconnectedAt: null, provider: "google" },
    user: { name: null, image: null, email: `${id}@x.com` },
    shares,
  };
}
