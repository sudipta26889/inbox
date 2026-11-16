import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import {
  getEmailAccount,
  invalidateAccountValidation,
} from "@/utils/redis/account-validation";
import {
  shareEmailAccountAction,
  unshareEmailAccountAction,
} from "@/utils/actions/email-account";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "owner", email: "owner@example.com" },
  })),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

const ACCOUNT = { id: "acct-1", email: "mailbox@example.com", userId: "owner" };
let shares: { emailAccountId: string; userId: string }[];
let cache: Map<string, unknown>;

describe("getEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shares = [];
    cache = new Map();
    vi.mocked(redis.get).mockImplementation(
      async (key: string) => (cache.get(key) ?? null) as never,
    );
    vi.mocked(redis.set).mockImplementation(async (key, value) => {
      cache.set(key, value);
      return "OK";
    });
    vi.mocked(redis.del).mockImplementation(async (key) => {
      cache.delete(key);
      return 1;
    });
    useInMemoryAccounts();
  });

  it("grants a shared user access and reports the owner to act as", async () => {
    shares.push({ emailAccountId: "acct-1", userId: "shared-user" });

    const access = await getEmailAccount({
      userId: "shared-user",
      emailAccountId: "acct-1",
    });

    expect(access).toEqual({
      email: "mailbox@example.com",
      ownerUserId: "owner",
    });
    expect(redis.set).toHaveBeenCalledWith(
      "account-access:shared-user:acct-1",
      access,
      { ex: 300 },
    );
  });

  it("denies a stranger and does not cache the refusal", async () => {
    expect(
      await getEmailAccount({ userId: "stranger", emailAccountId: "acct-1" }),
    ).toBeNull();
    expect(
      await getEmailAccount({ userId: "stranger", emailAccountId: "acct-1" }),
    ).toBeNull();

    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it("applies a new share on the next request after a refusal", async () => {
    await getEmailAccount({ userId: "friend", emailAccountId: "acct-1" });
    shares.push({ emailAccountId: "acct-1", userId: "friend" });

    expect(
      await getEmailAccount({ userId: "friend", emailAccountId: "acct-1" }),
    ).not.toBeNull();
  });

  it("serves a cached grant without hitting the database", async () => {
    cache.set("account-access:owner:acct-1", {
      email: "mailbox@example.com",
      ownerUserId: "owner",
    });

    expect(
      await getEmailAccount({ userId: "owner", emailAccountId: "acct-1" }),
    ).toEqual({ email: "mailbox@example.com", ownerUserId: "owner" });
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });

  it("ignores a legacy or garbage cached value and checks the database", async () => {
    cache.set("account-access:stranger:acct-1", "mailbox@example.com");

    expect(
      await getEmailAccount({ userId: "stranger", emailAccountId: "acct-1" }),
    ).toBeNull();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
  });

  it("refuses a revoked share on the very next request, cache included", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { id: "friend" },
    ] as never);

    await shareEmailAccountAction("acct-1", { email: "friend@example.com" });
    // Warm the cache the way a normal request would.
    expect(
      await getEmailAccount({ userId: "friend", emailAccountId: "acct-1" }),
    ).not.toBeNull();
    expect(cache.has("account-access:friend:acct-1")).toBe(true);

    await unshareEmailAccountAction("acct-1", { userId: "friend" });

    expect(
      await getEmailAccount({ userId: "friend", emailAccountId: "acct-1" }),
    ).toBeNull();
  });
});

describe("invalidateAccountValidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries once when Redis fails, then succeeds", async () => {
    vi.mocked(redis.del)
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValueOnce(1);

    await invalidateAccountValidation({ userId: "u", emailAccountId: "a" });

    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it("logs at error level when both attempts fail", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(redis.del).mockRejectedValue(new Error("redis down"));

    await invalidateAccountValidation({ userId: "u", emailAccountId: "a" });

    expect(redis.del).toHaveBeenCalledTimes(2);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain(
      "Failed to invalidate account access cache",
    );
    consoleError.mockRestore();
  });
});

function useInMemoryAccounts() {
  prisma.emailAccount.findUnique.mockImplementation((async ({
    where,
    select,
  }: {
    where: {
      id: string;
      OR: ({ userId: string } | { shares: { some: { userId: string } } })[];
    };
    select: Record<string, unknown>;
  }) => {
    if (where.id !== ACCOUNT.id) return null;
    const allowed = where.OR.some((clause) =>
      "userId" in clause
        ? clause.userId === ACCOUNT.userId
        : shares.some(
            (share) =>
              share.emailAccountId === ACCOUNT.id &&
              share.userId === clause.shares.some.userId,
          ),
    );
    if (!allowed) return null;
    // getEmailAccount selects userId; actionClient selects account.userId.
    return "account" in select
      ? {
          email: ACCOUNT.email,
          account: { userId: ACCOUNT.userId, provider: "google" },
        }
      : { email: ACCOUNT.email, userId: ACCOUNT.userId };
  }) as never);
  prisma.emailAccountShare.upsert.mockImplementation((async ({
    create,
  }: {
    create: { emailAccountId: string; userId: string };
  }) => {
    shares.push(create);
    return create;
  }) as never);
  prisma.emailAccountShare.deleteMany.mockImplementation((async ({
    where,
  }: {
    where: { emailAccountId: string; userId: string };
  }) => {
    shares = shares.filter(
      (share) =>
        !(
          share.emailAccountId === where.emailAccountId &&
          share.userId === where.userId
        ),
    );
    return { count: 1 };
  }) as never);
}
