import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listSenders, categorizeSenders } from "./senders";

vi.mock("@/utils/prisma");
vi.mock("@/utils/senders/record", () => ({
  upsertSenderRecord: vi.fn(),
}));
import { upsertSenderRecord } from "@/utils/senders/record";

const ctx = { userId: "user_1", emailAccountId: "ea_1" };

describe("listSenders", () => {
  it("lists all senders for the account when no categoryId filter", async () => {
    prisma.newsletter.findMany.mockResolvedValue([
      {
        id: "n1",
        email: "a@work.com",
        name: null,
        categoryId: "cat_work",
        category: { id: "cat_work", name: "Work" },
      },
      {
        id: "n2",
        email: "b@personal.com",
        name: null,
        categoryId: null,
        category: null,
      },
    ] as never);

    const result = await listSenders(ctx, {
      limit: 50,
      cursor: null,
      categoryId: null,
    });

    expect(result.senders).toHaveLength(2);
    expect(prisma.newsletter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("filters by categoryId", async () => {
    prisma.newsletter.findMany.mockResolvedValue([
      {
        id: "n1",
        email: "a@work.com",
        name: null,
        categoryId: "cat_work",
        category: { id: "cat_work", name: "Work" },
      },
    ] as never);

    const result = await listSenders(ctx, {
      limit: 50,
      cursor: null,
      categoryId: "cat_work",
    });

    expect(result.senders).toHaveLength(1);
    expect(result.senders[0].email).toBe("a@work.com");
    expect(prisma.newsletter.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: ctx.emailAccountId,
          categoryId: "cat_work",
        },
      }),
    );
  });
});

describe("categorizeSenders (bulk)", () => {
  it("assigns senders to categories and reports per-item outcomes", async () => {
    prisma.category.findMany.mockResolvedValue([
      { id: "cat_work" },
      { id: "cat_personal" },
    ] as never);
    vi.mocked(upsertSenderRecord).mockResolvedValue({} as never);

    const result = await categorizeSenders(ctx, {
      assignments: [
        { sender: "alice@work.com", categoryId: "cat_work" },
        { sender: "bob@personal.com", categoryId: "cat_personal" },
      ],
    });

    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect([...result.succeeded].sort()).toEqual([
      "alice@work.com",
      "bob@personal.com",
    ]);
    expect(upsertSenderRecord).toHaveBeenCalledTimes(2);
  });

  it("reports failure for unknown categoryId without aborting other items", async () => {
    prisma.category.findMany.mockResolvedValue([{ id: "cat_work" }] as never);
    vi.mocked(upsertSenderRecord).mockResolvedValue({} as never);

    const result = await categorizeSenders(ctx, {
      assignments: [
        { sender: "alice@work.com", categoryId: "cat_work" },
        { sender: "bob@bad.com", categoryId: "does-not-exist" },
      ],
    });

    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.succeeded).toEqual(["alice@work.com"]);
    expect(result.failed[0].id).toBe("bob@bad.com");
    expect(result.failed[0].error.code).toBe("NOT_FOUND");
  });
});
