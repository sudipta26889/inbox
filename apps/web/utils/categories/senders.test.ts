import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listSenders } from "./senders";

vi.mock("@/utils/prisma");

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
