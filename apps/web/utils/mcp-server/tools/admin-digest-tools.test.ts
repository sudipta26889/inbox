import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { adminDigestGet } from "./admin-digest-tools";
import type { McpToolContext } from "./registry";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const ctx: McpToolContext = {
  clientId: "client-1",
  userId: "u1",
  emailAccountId: "ea1",
  scopes: ["admin"],
};

describe("adminDigestGet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the current config wrapped in the success envelope", async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "r1",
        name: "News",
        systemType: SystemType.NEWSLETTER,
        actions: [{ type: ActionType.DIGEST }],
      },
    ] as any);

    const result = await adminDigestGet(ctx, {});

    expect(result).toEqual({
      ok: true,
      data: {
        enabled: false,
        schedule: null,
        items: [
          {
            ruleId: "r1",
            name: "News",
            systemType: SystemType.NEWSLETTER,
            enabled: true,
          },
        ],
      },
    });
  });

  it("returns VALIDATION_ERROR for unexpected input fields", async () => {
    const result = await adminDigestGet(ctx, { unexpected: "field" });

    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("VALIDATION_ERROR");
  });
});
