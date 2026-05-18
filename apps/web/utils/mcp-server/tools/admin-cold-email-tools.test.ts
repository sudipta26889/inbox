import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminColdEmailGetSettings,
  adminColdEmailListBlocked,
  adminColdEmailUpdateSettings,
} from "@/utils/mcp-server/tools/admin-cold-email-tools";
import { describe, expect, it, vi } from "vitest";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPattern: vi.fn(),
}));

const ctx: McpToolContext = {
  clientId: "client-1",
  userId: "test-user-mcp-ce",
  emailAccountId: "test-acc-mcp-ce",
  scopes: ["admin"],
};

describe("adminColdEmailGetSettings", () => {
  it("returns envelope { ok:true, data } with disabled defaults", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminColdEmailGetSettings(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.mode).toBe("DISABLED");
    }
  });

  it("returns settings when rule exists", async () => {
    prisma.rule.findUnique.mockImplementation(((args: unknown) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_x") {
        return Promise.resolve({
          id: "rule_x",
          instructions: "Block recruiters",
        });
      }
      return Promise.resolve({
        id: "rule_x",
        enabled: true,
        instructions: "Block recruiters",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
        ],
      });
    }) as never);

    const result = await adminColdEmailGetSettings(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.mode).toBe("LABEL");
      expect(result.data.prompt).toBe("Block recruiters");
    }
  });
});

describe("adminColdEmailUpdateSettings", () => {
  it("returns VALIDATION_ERROR on bad mode value", async () => {
    const result = await adminColdEmailUpdateSettings(ctx, { mode: "BOGUS" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates rule when enabling for the first time", async () => {
    let count = 0;
    prisma.rule.findUnique.mockImplementation(((args: unknown) => {
      count++;
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_new") {
        return Promise.resolve({
          id: "rule_new",
          instructions: "block all",
        });
      }
      if (count === 1) return Promise.resolve(null);
      return Promise.resolve({
        id: "rule_new",
        enabled: true,
        instructions: "block all",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
          { type: ActionType.ARCHIVE, label: null, labelId: null },
        ],
      });
    }) as never);
    prisma.rule.create.mockResolvedValue({ id: "rule_new" } as never);
    prisma.action.deleteMany.mockResolvedValue({ count: 0 } as never);
    prisma.action.createMany.mockResolvedValue({ count: 2 } as never);

    const result = await adminColdEmailUpdateSettings(ctx, {
      enabled: true,
      mode: "ARCHIVE_AND_LABEL",
      prompt: "block all",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.mode).toBe("ARCHIVE_AND_LABEL");
    }
  });
});

describe("adminColdEmailListBlocked", () => {
  it("returns empty data when no rule exists", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminColdEmailListBlocked(ctx, { limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
    }
  });

  it("applies default limit when not provided", async () => {
    prisma.rule.findUnique.mockResolvedValue({ groupId: null } as never);

    const result = await adminColdEmailListBlocked(ctx, {});

    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR for invalid limit", async () => {
    const result = await adminColdEmailListBlocked(ctx, { limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
