import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { adminKnowledgeGet, adminKnowledgeList } from "./admin-knowledge-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));

const ctx: McpToolContext = {
  clientId: "test-client",
  userId: "user_1",
  emailAccountId: "ea_1",
  scopes: ["admin"],
};

describe("adminKnowledgeList", () => {
  it("returns ok envelope with items", async () => {
    prisma.knowledge.findMany.mockResolvedValue([
      {
        id: "k1",
        title: "T1",
        content: "C1",
        emailAccountId: ctx.emailAccountId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const result = await adminKnowledgeList(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect(result.data.items).toHaveLength(1);
      expect((result.data.items[0] as { title: string }).title).toBe("T1");
    }
  });

  it("rejects malformed input with VALIDATION_ERROR", async () => {
    const result = await adminKnowledgeList(ctx, { limit: -3 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("adminKnowledgeGet", () => {
  it("returns the item for the owning account", async () => {
    prisma.knowledge.findFirst.mockResolvedValue({
      id: "k1",
      title: "T",
      content: "C",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await adminKnowledgeGet(ctx, { id: "k1" });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data.item as { id: string }).id).toBe("k1");
    }
  });

  it("returns NOT_FOUND for unknown id", async () => {
    prisma.knowledge.findFirst.mockResolvedValue(null);

    const result = await adminKnowledgeGet(ctx, { id: "nope" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns VALIDATION_ERROR on missing id", async () => {
    const result = await adminKnowledgeGet(ctx, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
