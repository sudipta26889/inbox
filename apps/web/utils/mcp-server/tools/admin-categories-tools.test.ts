import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { adminCategoriesList } from "./admin-categories-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
vi.mock("@/utils/senders/record", () => ({
  upsertSenderRecord: vi.fn(),
}));

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
      expect(result.data.categories[0].name).toBe("Newsletter");
    }
  });
});
