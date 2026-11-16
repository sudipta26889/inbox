import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  shareEmailAccountAction,
  unshareEmailAccountAction,
  updateEmailAccountRoleAction,
} from "./email-account";
import { invalidateAccountValidation } from "@/utils/redis/account-validation";

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
  const OWNER_ACCOUNT = {
    email: "owner@example.com",
    account: { userId: "user-1", provider: "google" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(OWNER_ACCOUNT as never);
    prisma.user.findFirst.mockResolvedValue({ id: "user-2" } as never);
  });

  it("lets the owner share by login email and drops the target's cached access", async () => {
    const result = await shareEmailAccountAction("email-account-1", {
      email: " Friend@Example.com ",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "email-account-1",
          OR: [
            { userId: "user-1" },
            { shares: { some: { userId: "user-1" } } },
          ],
        },
      }),
    );
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { email: "friend@example.com" },
          { emailAccounts: { some: { email: "friend@example.com" } } },
        ],
      },
      select: { id: true },
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

  it("refuses to share with someone who has never signed in", async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const result = await shareEmailAccountAction("email-account-1", {
      email: "nobody@example.com",
    });

    expect(result?.serverError).toBe(
      "No user found with that email. They need to sign in once first.",
    );
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
  });

  it("refuses to share an account with its own owner", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "user-1" } as never);

    const result = await shareEmailAccountAction("email-account-1", {
      email: "user@example.com",
    });

    expect(result?.serverError).toBe("You already own this account.");
  });

  it("does not let a shared user re-share or unshare the account", async () => {
    // The session user (user-1) reaches this account through a share from owner-9.
    prisma.emailAccount.findUnique.mockResolvedValue({
      ...OWNER_ACCOUNT,
      account: { userId: "owner-9", provider: "google" },
    } as never);

    const share = await shareEmailAccountAction("email-account-1", {
      email: "friend@example.com",
    });
    const unshare = await unshareEmailAccountAction("email-account-1", {
      userId: "user-3",
    });

    expect(share?.serverError).toBe(
      "Only the account owner can manage sharing.",
    );
    expect(unshare?.serverError).toBe(
      "Only the account owner can manage sharing.",
    );
    expect(prisma.emailAccountShare.upsert).not.toHaveBeenCalled();
    expect(prisma.emailAccountShare.deleteMany).not.toHaveBeenCalled();
  });

  it("refuses any account the user neither owns nor was shared", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const result = await shareEmailAccountAction("someone-elses-account", {
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
