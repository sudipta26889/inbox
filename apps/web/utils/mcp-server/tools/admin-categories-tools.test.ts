import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminCategoriesList,
  adminCategoriesCreate,
  adminCategoriesUpdate,
} from "./admin-categories-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
vi.mock("@/utils/senders/record", () => ({
  upsertSenderRecord: vi.fn(),
}));
import { isDuplicateError } from "@/utils/prisma-helpers";

const ctx: McpToolContext = {
  clientId: "test-client",
  userId: "user_1",
  emailAccountId: "ea_1",
  scopes: ["admin"],
};

describe("adminCategoriesList", () => {
  it("returns ok envelope with categories", async () => {
    prisma.category.findMany.mockResolvedValue([
      {
        id: "c1",
        name: "Newsletter",
        description: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const result = await adminCategoriesList(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.categories).toHaveLength(1);
      expect((result.data.categories[0] as { name: string }).name).toBe(
        "Newsletter",
      );
    }
  });
});

describe("adminCategoriesCreate", () => {
  it("creates a category and returns ok envelope", async () => {
    prisma.category.create.mockResolvedValue({
      id: "new_cat",
      name: "Work",
      description: "Work emails",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminCategoriesCreate(ctx, {
      name: "Work",
      description: "Work emails",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data.category as { name: string }).name).toBe("Work");
    }
  });

  it("returns VALIDATION_ERROR on missing name", async () => {
    const result = await adminCategoriesCreate(ctx, {
      description: "no name",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });

  it("returns CONFLICT on duplicate name", async () => {
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["name"] },
    });
    prisma.category.create.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);

    const result = await adminCategoriesCreate(ctx, { name: "Newsletter" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });
});

describe("adminCategoriesUpdate", () => {
  it("updates name and returns ok", async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: "cat_1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.category.update.mockResolvedValue({
      id: "cat_1",
      name: "Renamed",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminCategoriesUpdate(ctx, {
      categoryId: "cat_1",
      name: "Renamed",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data.category as { name: string }).name).toBe("Renamed");
    }
  });

  it("returns NOT_FOUND for unknown id", async () => {
    prisma.category.findUnique.mockResolvedValue(null);

    const result = await adminCategoriesUpdate(ctx, {
      categoryId: "missing",
      name: "x",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
