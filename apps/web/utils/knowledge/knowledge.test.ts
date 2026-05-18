import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getKnowledge, listKnowledge } from "./knowledge";
import { NotFoundError } from "@/utils/mcp-server/errors";

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

describe("getKnowledge", () => {
  it("returns the item for the owning account", async () => {
    const row = {
      id: "k1",
      title: "T",
      content: "C",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.knowledge.findFirst.mockResolvedValue(row as never);

    const out = await getKnowledge(ctx, { id: "k1" });

    expect(out.item.id).toBe("k1");
    expect(prisma.knowledge.findFirst).toHaveBeenCalledWith({
      where: { id: "k1", emailAccountId: ctx.emailAccountId },
    });
  });

  it("throws NotFoundError for unknown id", async () => {
    prisma.knowledge.findFirst.mockResolvedValue(null);

    await expect(getKnowledge(ctx, { id: "nope" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws NotFoundError when the item belongs to a different account (no existence leak)", async () => {
    // The findFirst's where clause filters by emailAccountId, so a row
    // owned by another account would not match → null returned.
    prisma.knowledge.findFirst.mockResolvedValue(null);

    await expect(getKnowledge(ctx, { id: "k_other" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
