import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockRedis } = vi.hoisted(() => ({
  mockRedis: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("@/utils/redis", () => ({ redis: mockRedis }));

import { createScopedLogger } from "@/utils/logger";
import { getReportWindowStart, markReportSent } from "./build";

const logger = createScopedLogger("test");
const now = new Date("2026-10-13T03:30:00Z");

describe("report window", () => {
  beforeEach(() => vi.clearAllMocks());

  it("defaults to 24 hours when no report was ever sent", async () => {
    mockRedis.get.mockResolvedValue(null);
    expect(
      await getReportWindowStart({ emailAccountId: "a", now, logger }),
    ).toEqual(new Date("2026-10-12T03:30:00Z"));
  });

  it("starts at the last successful send, so failed days are covered", async () => {
    mockRedis.get.mockResolvedValue("2026-10-09T03:31:00.000Z");
    expect(
      await getReportWindowStart({ emailAccountId: "a", now, logger }),
    ).toEqual(new Date("2026-10-09T03:31:00.000Z"));
  });

  it("never reaches back more than 7 days", async () => {
    mockRedis.get.mockResolvedValue("2026-09-01T00:00:00.000Z");
    expect(
      await getReportWindowStart({ emailAccountId: "a", now, logger }),
    ).toEqual(new Date("2026-10-06T03:30:00Z"));
  });

  it("falls back to 24 hours when the stored value is not a date", async () => {
    mockRedis.get.mockResolvedValue("garbage");
    expect(
      await getReportWindowStart({ emailAccountId: "a", now, logger }),
    ).toEqual(new Date("2026-10-12T03:30:00Z"));
  });

  it("treats a future stored value as invalid and warns", async () => {
    mockRedis.get.mockResolvedValue("2026-10-20T00:00:00.000Z");
    const warn = vi.spyOn(logger, "warn");
    expect(
      await getReportWindowStart({ emailAccountId: "a", now, logger }),
    ).toEqual(new Date("2026-10-12T03:30:00Z"));
    expect(warn).toHaveBeenCalledWith(
      "Morning report anchor is in the future; using 24h",
      expect.objectContaining({ lastSent: "2026-10-20T00:00:00.000Z" }),
    );
  });

  it("stores the send time without expiry", async () => {
    await markReportSent({ emailAccountIds: ["a", "b"], at: now });
    for (const id of ["a", "b"]) {
      expect(mockRedis.set).toHaveBeenCalledWith(
        `morning-report:last-sent:${id}`,
        now.toISOString(),
      );
    }
  });
});
