import { describe, it, expect, vi, beforeEach } from "vitest";
import { isColdEmail } from "./is-cold-email";
import { getEmailAccount } from "@/__tests__/helpers";
import type { EmailForLLM } from "@/utils/types";
import { GroupItemType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { extractEmailAddress } from "@/utils/email";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

vi.mock("./cold-email-rule", () => ({
  getColdEmailRule: vi.fn(),
}));

vi.mock("@/utils/email", async () => {
  const actual =
    await vi.importActual<typeof import("@/utils/email")>("@/utils/email");
  return {
    ...actual,
  };
});

vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(() => vi.fn()),
}));

const mockProvider = {
  hasPreviousCommunicationsWithSenderOrDomain: vi.fn().mockResolvedValue(false),
};

describe("isColdEmail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should recognize a known cold email sender even when from field format differs", async () => {
    const emailAccount = getEmailAccount({ id: "test-account-id" });
    const normalizedEmail = "cold.sender@example.com";
    const groupId = "test-group-id";

    // Mock groupItem lookup
    vi.mocked(prisma.groupItem.findFirst).mockResolvedValue({
      id: "group-item-id",
      exclude: false,
    } as any);

    const email: EmailForLLM = {
      id: "msg2",
      from: `"Cold Sender" <${normalizedEmail}>`,
      to: emailAccount.email,
      subject: "Another cold email",
      content: "This is another cold email",
      date: new Date(),
    };

    const result = await isColdEmail({
      email,
      emailAccount,
      provider: mockProvider as never,
      coldEmailRule: { instructions: "test instructions", groupId },
    });

    expect(result.isColdEmail).toBe(true);
    expect(result.reason).toBe("ai-already-labeled");

    // Verify that findFirst was called with the normalized email address
    expect(prisma.groupItem.findFirst).toHaveBeenCalledWith({
      where: {
        groupId,
        type: GroupItemType.FROM,
        value: { equals: normalizedEmail, mode: "insensitive" },
      },
      orderBy: { exclude: "desc" },
      select: { exclude: true },
    });
  });

  it("should return excluded when sender is explicitly excluded from cold email blocker", async () => {
    const emailAccount = getEmailAccount({ id: "test-account-id" });
    const normalizedEmail = "excluded.sender@example.com";
    const groupId = "test-group-id";

    // Mock groupItem lookup with exclude: true
    vi.mocked(prisma.groupItem.findFirst).mockResolvedValue({
      id: "group-item-id",
      exclude: true,
    } as any);

    const email: EmailForLLM = {
      id: "msg-excluded",
      from: `"Excluded Sender" <${normalizedEmail}>`,
      to: emailAccount.email,
      subject: "Not a cold email",
      content: "This sender was explicitly excluded",
      date: new Date(),
    };

    const result = await isColdEmail({
      email,
      emailAccount,
      provider: mockProvider as never,
      coldEmailRule: { instructions: "test instructions", groupId },
    });

    expect(result.isColdEmail).toBe(false);
    expect(result.reason).toBe("excluded");

    expect(prisma.groupItem.findFirst).toHaveBeenCalledWith({
      where: {
        groupId,
        type: GroupItemType.FROM,
        value: { equals: normalizedEmail, mode: "insensitive" },
      },
      orderBy: { exclude: "desc" },
      select: { exclude: true },
    });
  });

  it("honours an exclusion for a sender whose address has capital letters", async () => {
    const emailAccount = getEmailAccount({ id: "test-account-id" });
    const groupId = "test-group-id";
    vi.mocked(prisma.groupItem.findFirst).mockResolvedValue({
      id: "group-item-id",
      exclude: true,
    } as any);

    const result = await isColdEmail({
      email: {
        id: "msg-mixed-case",
        from: '"Jane Doe" <Jane.Doe@Acme.io>',
        to: emailAccount.email,
        subject: "Following up",
        content: "Checking in",
        date: new Date(),
      },
      emailAccount,
      provider: mockProvider as never,
      coldEmailRule: { instructions: "test instructions", groupId },
    });

    expect(result).toMatchObject({ isColdEmail: false, reason: "excluded" });
    expect(prisma.groupItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          value: { equals: "Jane.Doe@Acme.io", mode: "insensitive" },
        }),
      }),
    );
    expect(
      mockProvider.hasPreviousCommunicationsWithSenderOrDomain,
    ).not.toHaveBeenCalled();
  });

  it("should handle various email formats consistently", async () => {
    const emailAccount = getEmailAccount({ id: "test-account-id" });
    const normalizedEmail = "sender@example.com";
    const groupId = "test-group-id";

    vi.mocked(prisma.groupItem.findFirst).mockResolvedValue({
      id: "group-item-id",
      exclude: false,
    } as any);

    const emailFormats = [
      normalizedEmail,
      `<${normalizedEmail}>`,
      `"Display Name" <${normalizedEmail}>`,
      `Display Name <${normalizedEmail}>`,
      `  ${normalizedEmail}  `,
    ];

    for (const fromFormat of emailFormats) {
      vi.clearAllMocks();
      vi.mocked(prisma.groupItem.findFirst).mockResolvedValue({
        id: "group-item-id",
        exclude: false,
      } as any);

      const email: EmailForLLM = {
        id: "msg-test",
        from: fromFormat,
        to: emailAccount.email,
        subject: "Test",
        content: "Test content",
        date: new Date(),
      };

      const result = await isColdEmail({
        email,
        emailAccount,
        provider: mockProvider as never,
        coldEmailRule: { instructions: "test instructions", groupId },
      });

      expect(result.isColdEmail).toBe(true);
      expect(result.reason).toBe("ai-already-labeled");

      const expectedNormalized =
        extractEmailAddress(fromFormat) || fromFormat.trim();
      expect(prisma.groupItem.findFirst).toHaveBeenCalledWith({
        where: {
          groupId,
          type: GroupItemType.FROM,
          value: { equals: expectedNormalized, mode: "insensitive" },
        },
        orderBy: { exclude: "desc" },
        select: { exclude: true },
      });
    }
  });
});
