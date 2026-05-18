import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listKnowledge } from "./knowledge";

vi.mock("@/utils/prisma");

const ctx = { userId: "user_1", emailAccountId: "ea_1" };

describe("listKnowledge", () => {
  it("returns items scoped to the calling email account, newest-updated first", async () => {
    const items = [
      {
        id: "k2",
        title: "Newer",
        content: "b",
        emailAccountId: ctx.emailAccountId,
        createdAt: new Date("2026-01-02"),
        updatedAt: new Date("2026-01-02"),
      },
      {
        id: "k1",
        title: "Older",
        content: "a",
        emailAccountId: ctx.emailAccountId,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
      },
    ];
    prisma.knowledge.findMany.mockResolvedValue(items as never);

    const result = await listKnowledge(ctx, {});

    expect(result.items.map((i) => i.title)).toEqual(["Newer", "Older"]);
    expect(prisma.knowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
        orderBy: { updatedAt: "desc" },
      }),
    );
  });

  it("does not leak items from another emailAccountId", async () => {
    prisma.knowledge.findMany.mockResolvedValue([] as never);

    const result = await listKnowledge(ctx, {});

    expect(result.items).toEqual([]);
    expect(prisma.knowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("honors `limit` when provided", async () => {
    prisma.knowledge.findMany.mockResolvedValue([] as never);

    await listKnowledge(ctx, { limit: 5 });

    expect(prisma.knowledge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });
});
