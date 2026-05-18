import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { NewsletterStatus } from "@/generated/prisma/enums";
import {
  adminUnsubscribeList,
  adminUnsubscribeRequest,
} from "./admin-unsubscribe-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");

vi.mock("@/utils/senders/unsubscribe", () => ({
  unsubscribeSenderAndMark: vi.fn(async () => ({
    senderEmail: "n@x.com",
    status: NewsletterStatus.UNSUBSCRIBED,
    unsubscribe: {
      attempted: true,
      success: true,
      method: "post",
      statusCode: 200,
    },
  })),
  setSenderStatus: vi.fn(async () => undefined),
}));

vi.mock("@/utils/parse/unsubscribe", () => ({
  getHttpUnsubscribeLink: vi.fn(),
}));

vi.mock("@/utils/senders/record", () => ({
  extractEmailOrThrow: (s: string) => s,
}));

import { unsubscribeSenderAndMark } from "@/utils/senders/unsubscribe";
import { getHttpUnsubscribeLink } from "@/utils/parse/unsubscribe";

const ctx: McpToolContext = {
  clientId: "c1",
  userId: "user_1",
  emailAccountId: "ea_1",
  scopes: ["admin"],
};

describe("adminUnsubscribeList", () => {
  it("returns ok envelope with the candidate senders", async () => {
    prisma.newsletter.findMany.mockResolvedValue([
      {
        id: "n1",
        email: "n@x.com",
        name: null,
        status: NewsletterStatus.APPROVED,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    prisma.newsletter.count.mockResolvedValue(1 as never);

    const res = await adminUnsubscribeList(ctx, {});

    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect(res.data.total).toBe(1);
      expect(res.data.senders[0].email).toBe("n@x.com");
    }
  });

  it("returns VALIDATION_ERROR on bad input", async () => {
    const res = await adminUnsubscribeList(ctx, { limit: -5 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminUnsubscribeRequest", () => {
  beforeEach(() => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(
      "https://example.com/unsub?u=42",
    );
    vi.mocked(unsubscribeSenderAndMark).mockClear();
    vi.mocked(unsubscribeSenderAndMark).mockResolvedValue({
      senderEmail: "n@x.com",
      status: NewsletterStatus.UNSUBSCRIBED,
      unsubscribe: {
        attempted: true,
        success: true,
        method: "post",
        statusCode: 200,
      },
    } as never);
    prisma.newsletter.findUnique.mockResolvedValue(null as never);
  });

  it("dry-run returns preview without firing HTTP request", async () => {
    const res = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: "https://example.com/unsub?u=42",
      listUnsubscribeHeader: null,
      confirm: false,
    });

    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(true);
    const preview = res.preview as { targetEmail: string; method: string };
    expect(preview.targetEmail).toBe("n@x.com");
    expect(preview.method).toBe("http");
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
  });

  it("confirm:true fires the unsubscribe request", async () => {
    const res = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: "https://example.com/unsub?u=42",
      listUnsubscribeHeader: null,
      confirm: true,
    });

    expect(res.ok).toBe(true);
    expect(res.dryRun).toBe(false);
    expect(unsubscribeSenderAndMark).toHaveBeenCalledTimes(1);
  });

  it("returns STALE_STATE when sender is already UNSUBSCRIBED", async () => {
    prisma.newsletter.findUnique.mockResolvedValue({
      status: NewsletterStatus.UNSUBSCRIBED,
    } as never);

    const res = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: "https://example.com/unsub?u=42",
      listUnsubscribeHeader: null,
      confirm: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("STALE_STATE");
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
  });

  it("returns CONFLICT when only mailto: is available on commit", async () => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(undefined);
    const res = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "n@x.com",
      unsubscribeLink: null,
      listUnsubscribeHeader: "<mailto:unsub@x.com>",
      confirm: true,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("CONFLICT");
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR on bad input", async () => {
    const res = await adminUnsubscribeRequest(ctx, {
      newsletterEmail: "not-an-email",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
  });
});
