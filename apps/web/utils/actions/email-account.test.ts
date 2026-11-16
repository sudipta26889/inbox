import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  shareEmailAccountAction,
  unshareEmailAccountAction,
  updateEmailAccountRoleAction,
} from "./email-account";
import { invalidateAccountValidation } from "@/utils/redis/account-validation";
import { OWNER_ONLY_MESSAGE } from "@/utils/email-account-access";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/redis/account-validation", () => ({
  invalidateAccountValidation: vi.fn(),
}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

const { updateContactRoleMock } = vi.hoisted(() => ({
  updateContactRoleMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@inboxzero/loops", async (importActual) => {
  const actual = await importActual<typeof import("@inboxzero/loops")>();

  return {
    ...actual,
    updateContactRole: updateContactRoleMock,
  };
});

describe("updateEmailAccountRoleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: {
        userId: "user-1",
        provider: "google",
      },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);
    prisma.$transaction.mockImplementation(async (operations) =>
      Promise.all(operations as Promise<unknown>[]),
    );
    prisma.emailAccount.update.mockResolvedValue({
      id: "email-account-1",
    } as any);
    prisma.user.update.mockResolvedValue({ id: "user-1" } as any);
  });

  it("updates the email account role and stores the onboarding answer in one action", async () => {
    const result = await updateEmailAccountRoleAction("email-account-1", {
      role: "Founder",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "email-account-1" },
      data: { role: "Founder" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        onboardingAnswers: { answers: { role: "Founder" } },
        surveyRole: "Founder",
      },
    });
    expect(updateContactRoleMock).toHaveBeenCalledWith({
      email: "user@example.com",
      role: "Founder",
    });
  });

  it("can skip writing onboarding answers when another flow owns the transcript", async () => {
    const result = await updateEmailAccountRoleAction("email-account-1", {
      role: "Founder",
      writeOnboardingAnswers: false,
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        surveyRole: "Founder",
      },
    });
  });

  it("does not schedule the Loops role update when the DB transaction fails", async () => {
    prisma.$transaction.mockRejectedValue(new Error("db down"));

    const result = await updateEmailAccountRoleAction("email-account-1", {
      role: "Founder",
    });

    expect(result?.serverError).toBeDefined();
    expect(updateContactRoleMock).not.toHaveBeenCalled();
  });
});

describe("email account sharing", () => {
  // A tiny in-memory store so access checks run the real where clause.
  const accounts = [
    { id: "email-account-1", email: "owner@example.com", userId: "user-1" },
    { id: "foreign-account", email: "other@example.com", userId: "user-9" },
  ];
  let shares: { emailAccountId: string; userId: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    shares = [];
    prisma.emailAccount.findUnique.mockImplementation((async ({
      where,
    }: {
      where: AccessWhere;
    }) => {
      const account = accounts.find((a) => matchesAccess(a, where, shares));
      return account
        ? {
            email: account.email,
            account: { userId: account.userId, provider: "google" },
          }
        : null;
    }) as never);
    prisma.user.findMany.mockResolvedValue([{ id: "user-2" }] as never);
  });

  it("lets the owner share by login email and drops the target's cached access", async () => {
    const result = await shareEmailAccountAction("email-account-1", {
      email: " Friend@Example.com ",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { email: "friend@example.com" },
          { emailAccounts: { some: { email: "friend@example.com" } } },
        ],
      },
      select: { id: true },
      take: 2,
    });
    expect(prisma.emailAccountShare.upsert).toHaveBeenCalledWith({
      where: {
        emailAccountId_userId: {
          emailAccountId: "email-account-1",
          userId: "user-2",
        },
      },
      create: { emailAccountId: "email-account-1", userId: "user-2" },
      update: {},
    });
    expect(invalidateAccountValidation).toHaveBeenCalledWith({
      userId: "user-2",
      emailAccountId: "email-account-1",
    });
  });

  it("refuses an email that matches two different users", async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: "user-2" },
      { id: "user-3" },
    ] as never);

    const result = await shareEmailAccountAction("email-account-1", {
      email: "alias@example.com",
    });

    expect(result?.serverError).toBe(
      "That email belongs to more than one user. Use the email they sign in with.",
    );
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
  });

  it("refuses to share with someone who has never signed in", async () => {
    prisma.user.findMany.mockResolvedValue([]);

    const result = await shareEmailAccountAction("email-account-1", {
      email: "nobody@example.com",
    });

    expect(result?.serverError).toBe(
      "No user found with that email. They need to sign in once first.",
    );
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
  });

  it("refuses to share an account with its own owner", async () => {
    prisma.user.findMany.mockResolvedValue([{ id: "user-1" }] as never);

    const result = await shareEmailAccountAction("email-account-1", {
      email: "user@example.com",
    });

    expect(result?.serverError).toBe("You already own this account.");
  });

  it("does not let a shared user re-share or unshare the account", async () => {
    // user-1 (the session) reaches foreign-account only through this share.
    shares.push({ emailAccountId: "foreign-account", userId: "user-1" });

    const share = await shareEmailAccountAction("foreign-account", {
      email: "friend@example.com",
    });
    const unshare = await unshareEmailAccountAction("foreign-account", {
      userId: "user-3",
    });

    expect(share?.serverError).toBe(OWNER_ONLY_MESSAGE);
    expect(unshare?.serverError).toBe(OWNER_ONLY_MESSAGE);
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
    expect(prisma.emailAccountShare.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses an account the user neither owns nor was shared", async () => {
    const result = await shareEmailAccountAction("foreign-account", {
      email: "friend@example.com",
    });

    expect(result?.serverError).toBe("Unauthorized");
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
  });

  it("lets the owner remove access", async () => {
    const result = await unshareEmailAccountAction("email-account-1", {
      userId: "user-2",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.emailAccountShare.deleteMany).toHaveBeenCalledWith({
      where: { emailAccountId: "email-account-1", userId: "user-2" },
    });
    expect(invalidateAccountValidation).toHaveBeenCalledWith({
      userId: "user-2",
      emailAccountId: "email-account-1",
    });
  });
});

type AccessWhere = {
  id: string;
  OR: ({ userId: string } | { shares: { some: { userId: string } } })[];
};

function matchesAccess(
  account: { id: string; userId: string },
  where: AccessWhere,
  shares: { emailAccountId: string; userId: string }[],
) {
  if (account.id !== where.id) return false;
  return where.OR.some((clause) =>
    "userId" in clause
      ? clause.userId === account.userId
      : shares.some(
          (share) =>
            share.emailAccountId === account.id &&
            share.userId === clause.shares.some.userId,
        ),
  );
}
