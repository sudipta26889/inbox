import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { resolveCalendarAccount } from "./resolve-account";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const createProviders = vi.fn();
vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: (...args: unknown[]) =>
    createProviders(...args),
}));

const logger = createScopedLogger("test");

describe("resolveCalendarAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createProviders.mockResolvedValue([{ name: "google" }]);
  });

  it("defaults to the caller's own account, not a hardcoded one", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "acct-1",
      email: "me@example.com",
      timezone: "Asia/Kolkata",
    } as never);

    const result = await resolveCalendarAccount({
      userId: "user-1",
      emailAccountId: "acct-1",
      logger,
    });

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "acct-1", userId: "user-1" },
      select: { id: true, email: true, timezone: true },
    });
    expect(result.account.email).toBe("me@example.com");
    expect(createProviders).toHaveBeenCalledWith("acct-1", logger);
  });

  it("resolves 'from' against the user's own accounts", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "acct-2",
      email: "work@example.com",
      timezone: "Europe/London",
    } as never);

    const result = await resolveCalendarAccount({
      userId: "user-1",
      emailAccountId: "acct-1",
      from: "work@example.com",
      logger,
    });

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", email: "work@example.com" },
      select: { id: true, email: true, timezone: true },
    });
    expect(result.account.id).toBe("acct-2");
  });

  it("refuses a 'from' that is not the user's account", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);
    prisma.emailAccount.findMany.mockResolvedValue([] as never);

    await expect(
      resolveCalendarAccount({
        userId: "user-1",
        emailAccountId: "acct-1",
        from: "someone@else.com",
        logger,
      }),
    ).rejects.toThrow("someone@else.com");

    // Assert the scoping, not just the rejection: without userId in the where
    // clause this test would pass while leaking other users' accounts, since
    // EmailAccount.email is globally unique.
    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", email: "someone@else.com" },
      select: { id: true, email: true, timezone: true },
    });
  });

  it("names the accounts that do have a calendar when this one does not", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "acct-1",
      email: "me@example.com",
      timezone: null,
    } as never);
    createProviders.mockResolvedValue([]);
    prisma.emailAccount.findMany.mockResolvedValue([
      { email: "other@example.com" },
    ] as never);

    await expect(
      resolveCalendarAccount({
        userId: "user-1",
        emailAccountId: "acct-1",
        logger,
      }),
    ).rejects.toThrow("other@example.com");
  });
});
