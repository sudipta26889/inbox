import { describe, it, expect, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminKnowledgeCreate,
  adminKnowledgeDelete,
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

describe("adminKnowledgeDelete", () => {
  it("returns dryRun preview without mutating when confirm omitted", async () => {
    const now = new Date("2026-04-01T10:00:00Z");
    prisma.knowledge.findFirst.mockResolvedValue({
      id: "k_1",
      title: "tbd",
      content: "...",
      updatedAt: now,
    } as never);

    const result = await adminKnowledgeDelete(ctx, { id: "k_1" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
      const preview = result.preview as {
        action: string;
        knowledge: { id: string; title: string; updatedAt: string };
        irreversible: boolean;
      };
      expect(preview.action).toBe("delete_knowledge");
      expect(preview.knowledge.id).toBe("k_1");
      expect(preview.knowledge.title).toBe("tbd");
      expect(preview.knowledge.updatedAt).toBe(now.toISOString());
      expect(preview.irreversible).toBe(true);
    }
    expect(prisma.knowledge.delete).not.toHaveBeenCalled();
  });

  it("mutates when confirm:true", async () => {
    prisma.knowledge.findFirst.mockResolvedValue({
      id: "k_1",
      title: "real",
      content: "...",
      updatedAt: new Date(),
    } as never);
    prisma.knowledge.delete.mockResolvedValue({ id: "k_1" } as never);

    const result = await adminKnowledgeDelete(ctx, {
      id: "k_1",
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(false);
    }
    expect(prisma.knowledge.delete).toHaveBeenCalledWith({
      where: { id: "k_1" },
    });
  });

  it("returns NOT_FOUND when row does not exist (no confirm)", async () => {
    prisma.knowledge.findFirst.mockResolvedValue(null);

    const result = await adminKnowledgeDelete(ctx, { id: "nope" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("returns STALE_STATE when row disappears between dry-run and confirm", async () => {
    // Commit path: findFirst → null → STALE_STATE
    prisma.knowledge.findFirst.mockResolvedValue(null);

    const result = await adminKnowledgeDelete(ctx, {
      id: "k_1",
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STALE_STATE");
    }
  });

  it("returns VALIDATION_ERROR on missing id", async () => {
    const result = await adminKnowledgeDelete(ctx, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("admin_knowledge_* registry integration", () => {
  it("all five tools require the 'admin' scope", async () => {
    const { MCP_TOOLS, hasRequiredScope } = await import("./registry");
    for (const name of [
      "admin_knowledge_list",
      "admin_knowledge_get",
      "admin_knowledge_create",
      "admin_knowledge_update",
      "admin_knowledge_delete",
    ]) {
      const t = MCP_TOOLS[name];
      expect(t, name).toBeDefined();
      expect(t.requiredScope).toBe("admin");
      expect(hasRequiredScope(t, ["rules:read"])).toBe(false);
      expect(hasRequiredScope(t, ["admin"])).toBe(true);
    }
  });

  it("end-to-end CRUD via registry handlers", async () => {
    const { MCP_TOOLS } = await import("./registry");

    // Create
    prisma.knowledge.create.mockResolvedValue({
      id: "k_e2e",
      title: "K",
      content: "C",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(isDuplicateError).mockReturnValue(false);

    const created = (await MCP_TOOLS.admin_knowledge_create.handler(ctx, {
      title: "K",
      content: "C",
    })) as { ok: true; data: { item: { id: string } } };
    expect(created.ok).toBe(true);
    expect(created.data.item.id).toBe("k_e2e");

    // List
    prisma.knowledge.findMany.mockResolvedValue([
      {
        id: "k_e2e",
        title: "K",
        content: "C",
        emailAccountId: ctx.emailAccountId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const listed = (await MCP_TOOLS.admin_knowledge_list.handler(ctx, {})) as {
      ok: true;
      data: { items: Array<{ id: string }> };
    };
    expect(listed.data.items.map((i) => i.id)).toContain("k_e2e");

    // Update
    prisma.knowledge.findFirst.mockResolvedValueOnce({ id: "k_e2e" } as never);
    prisma.knowledge.update.mockResolvedValue({
      id: "k_e2e",
      title: "K2",
      content: "C2",
      emailAccountId: ctx.emailAccountId,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const updated = (await MCP_TOOLS.admin_knowledge_update.handler(ctx, {
      id: "k_e2e",
      title: "K2",
      content: "C2",
    })) as { ok: true; data: { item: { title: string } } };
    expect(updated.data.item.title).toBe("K2");

    // Delete dry-run
    prisma.knowledge.findFirst.mockResolvedValueOnce({
      id: "k_e2e",
      title: "K2",
      content: "C2",
      updatedAt: new Date(),
    } as never);
    const dry = (await MCP_TOOLS.admin_knowledge_delete.handler(ctx, {
      id: "k_e2e",
    })) as { ok: true; dryRun: true; preview: Record<string, unknown> };
    expect(dry.dryRun).toBe(true);

    // Delete confirm
    prisma.knowledge.findFirst.mockResolvedValueOnce({ id: "k_e2e" } as never);
    prisma.knowledge.findFirst.mockResolvedValueOnce({ id: "k_e2e" } as never);
    prisma.knowledge.delete.mockResolvedValue({ id: "k_e2e" } as never);
    const real = (await MCP_TOOLS.admin_knowledge_delete.handler(ctx, {
      id: "k_e2e",
      confirm: true,
    })) as { ok: true; dryRun: false; data: { id: string } };
    expect(real.ok).toBe(true);
    expect(real.dryRun).toBe(false);
    expect(real.data.id).toBe("k_e2e");
  });
});
