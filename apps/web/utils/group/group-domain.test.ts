import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listGroups } from "./group-domain";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));

const ctx = { userId: "user_1", emailAccountId: "ea_1" };

describe("listGroups", () => {
  it("returns empty array when no groups exist", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    const result = await listGroups(ctx);

    expect(result.groups).toEqual([]);
    expect(prisma.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("scopes findMany to caller emailAccountId", async () => {
    prisma.group.findMany.mockResolvedValue([] as never);

    await listGroups(ctx);

    expect(prisma.group.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("returns mapped groups with item count and rule link", async () => {
    const now = new Date();
    prisma.group.findMany.mockResolvedValue([
      {
        id: "g1",
        name: "Newsletters",
        prompt: null,
        createdAt: now,
        updatedAt: now,
        rule: { id: "r1", name: "Newsletter Rule" },
        _count: { items: 3 },
      },
    ] as never);

    const result = await listGroups(ctx);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      id: "g1",
      name: "Newsletters",
      itemCount: 3,
      rule: { id: "r1", name: "Newsletter Rule" },
    });
    expect(result.groups[0].createdAt).toBe(now.toISOString());
  });
});
