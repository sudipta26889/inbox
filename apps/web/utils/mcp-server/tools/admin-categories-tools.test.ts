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

describe("admin categories — end-to-end flow", () => {
  it("runs full lifecycle: create → list → categorize → update → dry-run delete → confirm delete", async () => {
    // 1. Create
    prisma.category.create.mockResolvedValue({
      id: "lifecycle_cat",
      name: "Lifecycle",
      description: "lifecycle test",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const created = await adminCategoriesCreate(ctx, {
      name: "Lifecycle",
      description: "lifecycle test",
    });
    expect(created.ok).toBe(true);
    const categoryId =
      created.ok && created.data
        ? (created.data.category as { id: string }).id
        : "";
    expect(categoryId).toBe("lifecycle_cat");

    // 2. List shows it
    prisma.category.findMany.mockResolvedValue([
      {
        id: categoryId,
        name: "Lifecycle",
        description: "lifecycle test",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const listed = await adminCategoriesList(ctx, {});
    expect(listed.ok).toBe(true);
    if (listed.ok && listed.data) {
      const names = listed.data.categories.map(
        (c) => (c as { name: string }).name,
      );
      expect(names).toContain("Lifecycle");
    }

    // 3. Categorize two senders into it
    prisma.category.findMany.mockResolvedValue([{ id: categoryId }] as never);
    vi.mocked(upsertSenderRecord).mockResolvedValue({} as never);
    const bulk = await adminSendersCategorize(ctx, {
      assignments: [
        { sender: "x@example.com", categoryId },
        { sender: "y@example.com", categoryId },
      ],
    });
    expect(bulk.ok).toBe(true);
    if (bulk.ok && bulk.data) {
      expect(bulk.data.successCount).toBe(2);
    }

    // 4. Senders list filtered shows them
    prisma.newsletter.findMany.mockResolvedValue([
      {
        id: "n1",
        email: "x@example.com",
        name: null,
        categoryId,
        category: { id: categoryId, name: "Lifecycle" },
      },
      {
        id: "n2",
        email: "y@example.com",
        name: null,
        categoryId,
        category: { id: categoryId, name: "Lifecycle" },
      },
    ] as never);
    const senders = await adminSendersList(ctx, { categoryId });
    expect(senders.ok).toBe(true);
    if (senders.ok && senders.data) {
      expect(senders.data.senders).toHaveLength(2);
    }

    // 5. Update the category description
    prisma.category.findUnique.mockResolvedValue({
      id: categoryId,
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.category.update.mockResolvedValue({
      id: categoryId,
      name: "Lifecycle",
      description: "renamed desc",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updated = await adminCategoriesUpdate(ctx, {
      categoryId,
      description: "renamed desc",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok && updated.data) {
      expect(
        (updated.data.category as { description: string }).description,
      ).toBe("renamed desc");
    }

    // 6. Dry-run delete: preview returns affected sender count, no DB change
    prisma.category.findUnique.mockResolvedValue({
      id: categoryId,
      name: "Lifecycle",
      description: "renamed desc",
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.newsletter.count.mockResolvedValue(2);

    const dryRun = await adminCategoriesDelete(ctx, { categoryId });
    expect(dryRun.ok).toBe(true);
    if (dryRun.ok) {
      expect(dryRun.dryRun).toBe(true);
      const preview = dryRun.preview as {
        willCascade: { detachSenders: number };
      };
      expect(preview.willCascade.detachSenders).toBe(2);
    }

    // 7. Confirm delete: actually removes
    prisma.category.findUnique.mockResolvedValue({
      id: categoryId,
      emailAccountId: ctx.emailAccountId,
    } as never);
    prisma.newsletter.updateMany.mockResolvedValue({ count: 2 } as never);
    prisma.category.delete.mockResolvedValue({ id: categoryId } as never);

    const confirmed = await adminCategoriesDelete(ctx, {
      categoryId,
      confirm: true,
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.dryRun).toBe(false);
    }
    expect(prisma.category.delete).toHaveBeenCalledWith({
      where: { id: categoryId },
    });
  });
});
