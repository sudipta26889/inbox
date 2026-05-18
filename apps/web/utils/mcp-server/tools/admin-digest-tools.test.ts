import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import {
  adminDigestGet,
  adminDigestUpdateItems,
  adminDigestUpdateSchedule,
} from "./admin-digest-tools";
import { MCP_TOOLS, getTool, hasRequiredScope } from "./registry";
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

describe("adminDigestUpdateSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("upserts schedule and returns success envelope", async () => {
    prisma.schedule.upsert.mockResolvedValue({
      intervalDays: 1,
      occurrences: 1,
      daysOfWeek: 127,
      timeOfDay: new Date("1970-01-01T09:00:00Z"),
      lastOccurrenceAt: new Date("2026-05-17T00:00:00Z"),
      nextOccurrenceAt: new Date("2026-05-17T09:00:00Z"),
    } as any);

    const result = await adminDigestUpdateSchedule(ctx, {
      intervalDays: 1,
      daysOfWeek: 127,
      timeOfDay: "1970-01-01T09:00:00Z",
      occurrences: 1,
    });

    expect(result.ok).toBe(true);
    expect((result as any).data.schedule.intervalDays).toBe(1);
    expect(prisma.schedule.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { emailAccountId: "ea1" } }),
    );
  });

  it("rejects all-null payload with VALIDATION_ERROR", async () => {
    const result = await adminDigestUpdateSchedule(ctx, {
      intervalDays: null,
      daysOfWeek: null,
      timeOfDay: null,
      occurrences: null,
    });

    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("VALIDATION_ERROR");
    expect(prisma.schedule.upsert).not.toHaveBeenCalled();
  });
});

describe("adminDigestUpdateItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies preferences and returns partial-failure envelope", async () => {
    prisma.rule.findUnique
      .mockResolvedValueOnce({ id: "r1", actions: [] } as any)
      .mockResolvedValueOnce(null);
    prisma.action.create.mockResolvedValue({} as any);

    const result = await adminDigestUpdateItems(ctx, {
      ruleDigestPreferences: { r1: true, ghost: true },
    });

    expect(result.ok).toBe(true);
    expect((result as any).data.successCount).toBe(1);
    expect((result as any).data.failureCount).toBe(1);
    expect((result as any).data.failed[0]).toEqual({
      id: "ghost",
      error: { code: "NOT_FOUND", message: "Rule not found" },
    });
  });

  it("rejects malformed input with VALIDATION_ERROR", async () => {
    const result = await adminDigestUpdateItems(ctx, {
      ruleDigestPreferences: { r1: "yes" },
    });

    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("VALIDATION_ERROR");
    expect(prisma.rule.findUnique).not.toHaveBeenCalled();
  });
});

describe("admin digest tool registration", () => {
  it("registers all three digest tools with admin scope", () => {
    for (const name of [
      "admin_digest_get",
      "admin_digest_update_schedule",
      "admin_digest_update_items",
    ]) {
      const tool = getTool(name);
      expect(tool).toBeDefined();
      expect(tool!.requiredScope).toBe("admin");
    }
  });

  it("admin scope is required (rules:read is insufficient)", () => {
    const tool = MCP_TOOLS.admin_digest_get;
    expect(hasRequiredScope(tool, ["rules:read"])).toBe(false);
    expect(hasRequiredScope(tool, ["admin"])).toBe(true);
  });
});
