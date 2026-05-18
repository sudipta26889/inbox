import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { getDigestConfig } from "./domain";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

describe("getDigestConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns enabled=false when no schedule exists", async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue([]);

    const result = await getDigestConfig({
      userId: "u1",
      emailAccountId: "ea1",
    });

    expect(result.enabled).toBe(false);
    expect(result.schedule).toBeNull();
    expect(result.items).toEqual([]);
  });

  it("returns schedule + items when configured", async () => {
    const timeOfDay = new Date("1970-01-01T09:00:00Z");
    prisma.schedule.findUnique.mockResolvedValue({
      id: "s1",
      intervalDays: 1,
      occurrences: 1,
      daysOfWeek: 127,
      timeOfDay,
      lastOccurrenceAt: new Date("2026-05-16T09:00:00Z"),
      nextOccurrenceAt: new Date("2026-05-17T09:00:00Z"),
    } as any);
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "r1",
        name: "Newsletters",
        systemType: SystemType.NEWSLETTER,
        actions: [{ type: ActionType.DIGEST }],
      },
      {
        id: "r2",
        name: "Receipts",
        systemType: SystemType.RECEIPT,
        actions: [],
      },
    ] as any);

    const result = await getDigestConfig({
      userId: "u1",
      emailAccountId: "ea1",
    });

    expect(result.enabled).toBe(true);
    expect(result.schedule).toEqual({
      intervalDays: 1,
      occurrences: 1,
      daysOfWeek: 127,
      timeOfDay,
      lastOccurrenceAt: new Date("2026-05-16T09:00:00Z"),
      nextOccurrenceAt: new Date("2026-05-17T09:00:00Z"),
    });
    expect(result.items).toEqual([
      {
        ruleId: "r1",
        name: "Newsletters",
        systemType: SystemType.NEWSLETTER,
        enabled: true,
      },
      {
        ruleId: "r2",
        name: "Receipts",
        systemType: SystemType.RECEIPT,
        enabled: false,
      },
    ]);
  });

  it("filters rules by emailAccountId", async () => {
    prisma.schedule.findUnique.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue([]);

    await getDigestConfig({ userId: "u1", emailAccountId: "ea1" });

    expect(prisma.rule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "ea1" },
      }),
    );
    expect(prisma.schedule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "ea1" },
      }),
    );
  });
});
