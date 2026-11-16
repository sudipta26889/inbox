import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import {
  listUnsubscribeCandidates,
  requestUnsubscribe,
} from "@/utils/unsubscriber/domain";

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

const userId = "user_1";
const emailAccountId = "ea_1";
const testLogger = createScopedLogger("test:unsubscriber");

describe("listUnsubscribeCandidates", () => {
  it("returns all senders scoped to the account", async () => {
    prisma.newsletter.findMany.mockResolvedValue([
      {
        id: "n1",
        email: "news1@x.com",
        name: null,
        status: NewsletterStatus.APPROVED,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "n2",
        email: "news2@x.com",
        name: null,
        status: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    prisma.newsletter.count.mockResolvedValue(2 as never);

    const { senders, total } = await listUnsubscribeCandidates(
      { userId, emailAccountId },
      {},
    );
    expect(total).toBe(2);
    expect(senders).toHaveLength(2);
    expect(prisma.newsletter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { emailAccountId } }),
    );
  });

  it("filters by status", async () => {
    prisma.newsletter.findMany.mockResolvedValue([] as never);
    prisma.newsletter.count.mockResolvedValue(0 as never);

    await listUnsubscribeCandidates(
      { userId, emailAccountId },
      { status: NewsletterStatus.UNSUBSCRIBED },
    );

    expect(prisma.newsletter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId,
          status: NewsletterStatus.UNSUBSCRIBED,
        },
      }),
    );
  });
});

describe("requestUnsubscribe (dry-run)", () => {
  beforeEach(() => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(
      "https://example.com/unsub?u=1",
    );
    vi.mocked(unsubscribeSenderAndMark).mockClear();
  });

  it("returns target + method preview and does NOT call unsubscribeSenderAndMark or DB", async () => {
    const res = await requestUnsubscribe(
      { userId, emailAccountId, logger: testLogger },
      {
        newsletterEmail: "news3@x.com",
        unsubscribeLink: "https://example.com/unsub?u=1",
        listUnsubscribeHeader: null,
        confirm: false,
      },
    );
    expect(res.dryRun).toBe(true);
    if (!res.dryRun) throw new Error("expected dry-run");
    expect(res.preview.targetEmail).toBe("news3@x.com");
    expect(res.preview.method).toBe("http");
    expect(res.preview.targetUrl).toBe("https://example.com/unsub?u=1");
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
    expect(prisma.newsletter.findUnique).not.toHaveBeenCalled();
  });

  it("reports method=mailto when only a mailto: header is available", async () => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(undefined);
    const res = await requestUnsubscribe(
      { userId, emailAccountId, logger: testLogger },
      {
        newsletterEmail: "news3@x.com",
        unsubscribeLink: null,
        listUnsubscribeHeader: "<mailto:unsub@x.com>",
        confirm: false,
      },
    );
    if (!res.dryRun) throw new Error("expected dry-run");
    expect(res.preview.method).toBe("mailto");
    expect(res.preview.targetUrl).toBe("unsub@x.com");
  });

  it("reports method=none when no unsubscribe channel exists", async () => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(undefined);
    const res = await requestUnsubscribe(
      { userId, emailAccountId, logger: testLogger },
      {
        newsletterEmail: "news3@x.com",
        unsubscribeLink: null,
        listUnsubscribeHeader: null,
        confirm: false,
      },
    );
    if (!res.dryRun) throw new Error("expected dry-run");
    expect(res.preview.method).toBe("none");
    expect(res.preview.targetUrl).toBeNull();
  });
});

describe("requestUnsubscribe (commit)", () => {
  beforeEach(() => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(
      "https://example.com/unsub?u=1",
    );
    vi.mocked(unsubscribeSenderAndMark).mockClear();
    vi.mocked(unsubscribeSenderAndMark).mockResolvedValue({
      senderEmail: "news3@x.com",
      status: NewsletterStatus.UNSUBSCRIBED,
      unsubscribe: {
        attempted: true,
        success: true,
        method: "post",
        statusCode: 200,
      },
    } as never);
  });

  it("calls unsubscribeSenderAndMark when confirm:true and returns its result", async () => {
    prisma.newsletter.findUnique.mockResolvedValue(null as never);

    const res = await requestUnsubscribe(
      { userId, emailAccountId, logger: testLogger },
      {
        newsletterEmail: "news3@x.com",
        unsubscribeLink: "https://example.com/unsub?u=1",
        listUnsubscribeHeader: null,
        confirm: true,
      },
    );
    expect(res.dryRun).toBe(false);
    if (res.dryRun) throw new Error("expected commit");
    expect(res.data.status).toBe(NewsletterStatus.UNSUBSCRIBED);
    expect(unsubscribeSenderAndMark).toHaveBeenCalledTimes(1);
  });

  it("throws ConflictError on commit when only mailto: is available", async () => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(undefined);
    prisma.newsletter.findUnique.mockResolvedValue(null as never);

    await expect(
      requestUnsubscribe(
        { userId, emailAccountId, logger: testLogger },
        {
          newsletterEmail: "news3@x.com",
          unsubscribeLink: null,
          listUnsubscribeHeader: "<mailto:unsub@x.com>",
          confirm: true,
        },
      ),
    ).rejects.toThrow(/mailto/i);
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
  });

  it("throws ConflictError on commit when no unsubscribe channel exists", async () => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(undefined);
    prisma.newsletter.findUnique.mockResolvedValue(null as never);

    await expect(
      requestUnsubscribe(
        { userId, emailAccountId, logger: testLogger },
        {
          newsletterEmail: "news3@x.com",
          unsubscribeLink: null,
          listUnsubscribeHeader: null,
          confirm: true,
        },
      ),
    ).rejects.toThrow(/No unsubscribe URL/);
  });
});

describe("requestUnsubscribe (STALE_STATE)", () => {
  beforeEach(() => {
    vi.mocked(getHttpUnsubscribeLink).mockReturnValue(
      "https://example.com/unsub?u=2",
    );
    vi.mocked(unsubscribeSenderAndMark).mockClear();
  });

  it("throws STALE_STATE when sender is already UNSUBSCRIBED", async () => {
    prisma.newsletter.findUnique.mockResolvedValue({
      status: NewsletterStatus.UNSUBSCRIBED,
    } as never);

    await expect(
      requestUnsubscribe(
        { userId, emailAccountId, logger: testLogger },
        {
          newsletterEmail: "news2@x.com",
          unsubscribeLink: "https://example.com/unsub?u=2",
          listUnsubscribeHeader: null,
          confirm: true,
        },
      ),
    ).rejects.toThrow(/STALE_STATE/);
    expect(unsubscribeSenderAndMark).not.toHaveBeenCalled();
  });
});
