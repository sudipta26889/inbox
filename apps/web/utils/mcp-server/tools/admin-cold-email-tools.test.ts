import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { adminColdEmailGetSettings } from "@/utils/mcp-server/tools/admin-cold-email-tools";
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
