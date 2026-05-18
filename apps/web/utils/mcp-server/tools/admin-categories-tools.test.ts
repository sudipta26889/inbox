import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminCategoriesList,
  adminCategoriesCreate,
  adminCategoriesUpdate,
  adminCategoriesDelete,
  adminSendersList,
  adminSendersCategorize,
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
import { upsertSenderRecord } from "@/utils/senders/record";

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

describe("adminCategoriesDelete", () => {
  it("dry-run (confirm omitted) previews and does not delete", async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: "cat_1",
      name: "ToDelete",
      description: null,
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.newsletter.count.mockResolvedValue(2);

    const result = await adminCategoriesDelete(ctx, { categoryId: "cat_1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
      expect(result.preview).toBeDefined();
    }
    expect(prisma.category.delete).not.toHaveBeenCalled();
  });

  it("confirm:true deletes the category", async () => {
    prisma.category.findUnique.mockResolvedValue({
      id: "cat_1",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.newsletter.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.category.delete.mockResolvedValue({ id: "cat_1" } as never);

    const result = await adminCategoriesDelete(ctx, {
      categoryId: "cat_1",
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(false);
    }
    expect(prisma.category.delete).toHaveBeenCalledWith({
      where: { id: "cat_1" },
    });
  });

  it("returns NOT_FOUND for unknown id (both dry-run and confirm)", async () => {
    prisma.category.findUnique.mockResolvedValue(null);
    const dryRun = await adminCategoriesDelete(ctx, { categoryId: "missing" });
    expect(dryRun.ok).toBe(false);
    if (!dryRun.ok) {
      expect(dryRun.error.code).toBe("NOT_FOUND");
    }

    prisma.category.findUnique.mockResolvedValue(null);
    const confirm = await adminCategoriesDelete(ctx, {
      categoryId: "missing",
      confirm: true,
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) {
      expect(confirm.error.code).toBe("NOT_FOUND");
    }
  });
});

describe("adminSendersList", () => {
  it("returns ok envelope with all senders", async () => {
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

    const result = await adminSendersList(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.senders).toHaveLength(2);
    }
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

    const result = await adminSendersList(ctx, { categoryId: "cat_work" });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.senders).toHaveLength(1);
      expect((result.data.senders[0] as { email: string }).email).toBe(
        "a@work.com",
      );
    }
  });
});

describe("adminSendersCategorize", () => {
  it("returns per-item success/failure envelope", async () => {
    prisma.category.findMany.mockResolvedValue([{ id: "cat_work" }] as never);
    vi.mocked(upsertSenderRecord).mockResolvedValue({} as never);

    const result = await adminSendersCategorize(ctx, {
      assignments: [
        { sender: "alice@work.com", categoryId: "cat_work" },
        { sender: "bob@bad.com", categoryId: "missing-cat" },
      ],
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.successCount).toBe(1);
      expect(result.data.failureCount).toBe(1);
      expect(result.data.succeeded).toEqual(["alice@work.com"]);
      expect(result.data.failed[0].id).toBe("bob@bad.com");
      expect(result.data.failed[0].error.code).toBe("NOT_FOUND");
    }
  });

  it("returns VALIDATION_ERROR on empty assignments array", async () => {
    const result = await adminSendersCategorize(ctx, { assignments: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
