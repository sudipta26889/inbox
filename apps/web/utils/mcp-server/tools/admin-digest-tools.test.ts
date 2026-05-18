import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import {
  adminDigestGet,
  adminDigestSetEnabled,
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

describe("adminDigestSetEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns success envelope with enabled=false after disabling", async () => {
    prisma.schedule.deleteMany.mockResolvedValue({ count: 1 } as any);

    const result = await adminDigestSetEnabled(ctx, { enabled: false });

    expect(result).toEqual({ ok: true, data: { enabled: false } });
  });

  it("returns success envelope with enabled=true after enabling", async () => {
    prisma.schedule.upsert.mockResolvedValue({} as any);
    prisma.rule.findFirst.mockResolvedValue(null);

    const result = await adminDigestSetEnabled(ctx, { enabled: true });

    expect(result).toEqual({ ok: true, data: { enabled: true } });
  });

  it("rejects missing `enabled` field with VALIDATION_ERROR", async () => {
    const result = await adminDigestSetEnabled(ctx, {});

    expect(result.ok).toBe(false);
    expect((result as any).error.code).toBe("VALIDATION_ERROR");
    expect(prisma.schedule.upsert).not.toHaveBeenCalled();
    expect(prisma.schedule.deleteMany).not.toHaveBeenCalled();
  });

  it("is registered with admin scope", () => {
    const tool = getTool("admin_digest_set_enabled");
    expect(tool).toBeDefined();
    expect(tool!.requiredScope).toBe("admin");
  });
});

describe("admin_digest integration: get → update_schedule → update_items → set_enabled → get", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reflects schedule + item + enabled changes in subsequent get calls", async () => {
    // 1. Initial get: no schedule, one rule with no digest action
    prisma.schedule.findUnique.mockResolvedValueOnce(null);
    prisma.rule.findMany.mockResolvedValueOnce([
      {
        id: "r1",
        name: "Newsletters",
        systemType: SystemType.NEWSLETTER,
        actions: [],
      },
    ] as any);

    const initial = await adminDigestGet(ctx, {});
    expect((initial as any).data.enabled).toBe(false);
    expect((initial as any).data.items[0].enabled).toBe(false);

    // 2. Update schedule
    const timeOfDay = new Date("1970-01-01T09:00:00Z");
    prisma.schedule.upsert.mockResolvedValueOnce({
      intervalDays: 1,
      occurrences: 1,
      daysOfWeek: 127,
      timeOfDay,
      lastOccurrenceAt: new Date("2026-05-17T00:00:00Z"),
      nextOccurrenceAt: new Date("2026-05-17T09:00:00Z"),
    } as any);
    const scheduleResult = await adminDigestUpdateSchedule(ctx, {
      intervalDays: 1,
      daysOfWeek: 127,
      timeOfDay: "1970-01-01T09:00:00Z",
      occurrences: 1,
    });
    expect(scheduleResult.ok).toBe(true);

    // 3. Update items: enable digest on r1
    prisma.rule.findUnique.mockResolvedValueOnce({
      id: "r1",
      actions: [],
    } as any);
    prisma.action.create.mockResolvedValueOnce({} as any);
    const itemsResult = await adminDigestUpdateItems(ctx, {
      ruleDigestPreferences: { r1: true },
    });
    expect(itemsResult.ok).toBe(true);
    expect((itemsResult as any).data.successCount).toBe(1);

    // 4. Get after item update: schedule present, item enabled
    prisma.schedule.findUnique.mockResolvedValueOnce({
      intervalDays: 1,
      occurrences: 1,
      daysOfWeek: 127,
      timeOfDay,
      lastOccurrenceAt: new Date("2026-05-17T00:00:00Z"),
      nextOccurrenceAt: new Date("2026-05-17T09:00:00Z"),
    } as any);
    prisma.rule.findMany.mockResolvedValueOnce([
      {
        id: "r1",
        name: "Newsletters",
        systemType: SystemType.NEWSLETTER,
        actions: [{ type: ActionType.DIGEST }],
      },
    ] as any);
    const afterItems = await adminDigestGet(ctx, {});
    expect(afterItems.ok).toBe(true);
    expect((afterItems as any).data.enabled).toBe(true);
    expect((afterItems as any).data.schedule.intervalDays).toBe(1);
    expect((afterItems as any).data.items[0].enabled).toBe(true);

    // 5. Disable digest via set_enabled
    prisma.schedule.deleteMany.mockResolvedValueOnce({ count: 1 } as any);
    const disableResult = await adminDigestSetEnabled(ctx, { enabled: false });
    expect(disableResult.ok).toBe(true);
    expect((disableResult as any).data.enabled).toBe(false);

    // 6. Final get: schedule gone, item still has DIGEST action on rule
    prisma.schedule.findUnique.mockResolvedValueOnce(null);
    prisma.rule.findMany.mockResolvedValueOnce([
      {
        id: "r1",
        name: "Newsletters",
        systemType: SystemType.NEWSLETTER,
        actions: [{ type: ActionType.DIGEST }],
      },
    ] as any);
    const final = await adminDigestGet(ctx, {});
    expect(final.ok).toBe(true);
    expect((final as any).data.enabled).toBe(false);
    expect((final as any).data.schedule).toBeNull();
  });
});
