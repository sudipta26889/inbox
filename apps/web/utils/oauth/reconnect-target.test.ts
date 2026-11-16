import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canLinkForUser,
  findReconnectTarget,
  isReconnectTargetMismatch,
} from "@/utils/oauth/reconnect-target";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");

describe("isReconnectTargetMismatch", () => {
  it("accepts an add-account flow, which names no target", () => {
    expect(
      isReconnectTargetMismatch({
        reconnectEmailAccountId: null,
        matchedEmailAccountId: "anything",
      }),
    ).toBe(false);
  });

  it("accepts a reconnect that came back as the same mailbox", () => {
    expect(
      isReconnectTargetMismatch({
        reconnectEmailAccountId: "mailbox",
        matchedEmailAccountId: "mailbox",
      }),
    ).toBe(false);
  });

  it("rejects a reconnect that came back as a different mailbox", () => {
    expect(
      isReconnectTargetMismatch({
        reconnectEmailAccountId: "mailbox",
        matchedEmailAccountId: "other-mailbox",
      }),
    ).toBe(true);
  });

  it("rejects a reconnect that matched no existing account", () => {
    expect(
      isReconnectTargetMismatch({
        reconnectEmailAccountId: "mailbox",
        matchedEmailAccountId: undefined,
      }),
    ).toBe(true);
  });
});

describe("findReconnectTarget", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findFirst.mockResolvedValue(null);
  });

  it("scopes the lookup to mailboxes the user owns or was shared, and the provider", async () => {
    await findReconnectTarget({
      emailAccountId: "mailbox",
      userId: "user",
      provider: "microsoft",
    });

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "mailbox",
          OR: [{ userId: "user" }, { shares: { some: { userId: "user" } } }],
          account: { provider: "microsoft" },
        },
      }),
    );
  });
});

describe("canLinkForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccountShare.findFirst.mockResolvedValue(null);
  });

  it("lets the user named in the state link", async () => {
    expect(
      await canLinkForUser({
        actorUserId: "owner",
        targetUserId: "owner",
        reconnectEmailAccountId: null,
      }),
    ).toBe(true);
    expect(prisma.emailAccountShare.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a callback with no session", async () => {
    expect(
      await canLinkForUser({
        actorUserId: null,
        targetUserId: "owner",
        reconnectEmailAccountId: "mailbox",
      }),
    ).toBe(false);
  });

  it("refuses another user's state when nothing is being reconnected", async () => {
    expect(
      await canLinkForUser({
        actorUserId: "other",
        targetUserId: "owner",
        reconnectEmailAccountId: null,
      }),
    ).toBe(false);
  });

  it("lets a shared user reconnect the owner's mailbox while the share exists", async () => {
    prisma.emailAccountShare.findFirst.mockResolvedValue({ id: "s" } as never);

    expect(
      await canLinkForUser({
        actorUserId: "shared",
        targetUserId: "owner",
        reconnectEmailAccountId: "mailbox",
      }),
    ).toBe(true);
    expect(prisma.emailAccountShare.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "shared",
        emailAccount: { id: "mailbox", userId: "owner" },
      },
      select: { id: true },
    });
  });

  it("refuses a non-shared user carrying the owner's reconnect state", async () => {
    expect(
      await canLinkForUser({
        actorUserId: "stranger",
        targetUserId: "owner",
        reconnectEmailAccountId: "mailbox",
      }),
    ).toBe(false);
  });
});
