import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { listCategories, createCategory, updateCategory } from "./categories";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
import { isDuplicateError } from "@/utils/prisma-helpers";

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

describe("createCategory", () => {
  it("creates a new category", async () => {
    const created = {
      id: "new_cat",
      name: "Work",
      description: "Work emails",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.category.create.mockResolvedValue(created as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await createCategory(ctx, {
      name: "Work",
      description: "Work emails",
    });

    expect(result.category.id).toBe("new_cat");
    expect(result.category.name).toBe("Work");
    expect(result.category.description).toBe("Work emails");
    expect(prisma.category.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailAccountId: ctx.emailAccountId,
          name: "Work",
          description: "Work emails",
        }),
      }),
    );
  });

  it("throws ConflictError on duplicate name", async () => {
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["name"] },
    });
    prisma.category.create.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);

    await expect(
      createCategory(ctx, { name: "Newsletter" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("updateCategory", () => {
  it("updates name and description", async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: "cat_1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.category.update.mockResolvedValue({
      id: "cat_1",
      name: "Renamed",
      description: "New desc",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await updateCategory(ctx, {
      categoryId: "cat_1",
      name: "Renamed",
      description: "New desc",
    });

    expect(result.category.name).toBe("Renamed");
    expect(result.category.description).toBe("New desc");
  });

  it("throws NotFoundError when category does not exist", async () => {
    prisma.category.findUnique.mockResolvedValue(null);

    await expect(
      updateCategory(ctx, { categoryId: "missing-id", name: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when category belongs to a different account", async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: "cat_1",
      emailAccountId: "ea_other",
    } as never);

    await expect(
      updateCategory(ctx, { categoryId: "cat_1", name: "x" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
