import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminKnowledgeCreate,
  adminKnowledgeGet,
  adminKnowledgeList,
  adminKnowledgeUpdate,
} from "./admin-knowledge-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(),
}));
import { isDuplicateError } from "@/utils/prisma-helpers";

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

describe("adminKnowledgeCreate", () => {
  it("inserts a row and returns ok envelope", async () => {
    prisma.knowledge.create.mockResolvedValue({
      id: "k_new",
      title: "MCP-Created",
      content: "via mcp",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminKnowledgeCreate(ctx, {
      title: "MCP-Created",
      content: "via mcp",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data.item as { title: string }).title).toBe("MCP-Created");
    }
  });

  it("returns CONFLICT on duplicate title", async () => {
    const dupErr = Object.assign(new Error("dup"), {
      code: "P2002",
      meta: { target: ["emailAccountId", "title"] },
    });
    prisma.knowledge.create.mockRejectedValue(dupErr);
    vi.mocked(isDuplicateError).mockReturnValue(true);

    const result = await adminKnowledgeCreate(ctx, {
      title: "dup",
      content: "b",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
    }
  });

  it("returns VALIDATION_ERROR on empty title", async () => {
    const result = await adminKnowledgeCreate(ctx, { title: "", content: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminKnowledgeUpdate", () => {
  it("modifies the row", async () => {
    prisma.knowledge.findFirst.mockResolvedValue({ id: "k_1" } as never);
    prisma.knowledge.update.mockResolvedValue({
      id: "k_1",
      title: "new",
      content: "y",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const result = await adminKnowledgeUpdate(ctx, {
      id: "k_1",
      title: "new",
      content: "y",
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.data) {
      expect((result.data.item as { title: string }).title).toBe("new");
    }
  });

  it("returns NOT_FOUND for cross-account (or unknown) id", async () => {
    prisma.knowledge.findFirst.mockResolvedValue(null);

    const result = await adminKnowledgeUpdate(ctx, {
      id: "k_other",
      title: "hack",
      content: "h",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });
});
