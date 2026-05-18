import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listCategories } from "./categories";

vi.mock("@/utils/prisma");

const ctx = { userId: "user_1", emailAccountId: "ea_1" };

describe("listCategories", () => {
  it("returns categories scoped to the email account", async () => {
    const fakeCategories = [
      {
        id: "c1",
        name: "Newsletter",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "c2",
        name: "Receipt",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    prisma.category.findMany.mockResolvedValue(fakeCategories as never);

    const result = await listCategories(ctx);

    expect(result.categories).toHaveLength(2);
    expect(result.categories.map((c) => c.name).sort()).toEqual([
      "Newsletter",
      "Receipt",
    ]);
    expect(prisma.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });

  it("does not leak categories from another email account", async () => {
    prisma.category.findMany.mockResolvedValue([] as never);

    const result = await listCategories(ctx);

    expect(result.categories).toHaveLength(0);
    expect(prisma.category.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: ctx.emailAccountId },
      }),
    );
  });
});
