import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: { CRON_SECRET: "cron-secret" } }));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn(), del: vi.fn() } }));
vi.mock("@/utils/a2a/daily-digest", () => ({
  buildDailyDigest: vi.fn(),
  getLocalDate: vi.fn(() => "2026-11-16"),
  getLocalHour: vi.fn(() => 9),
  pushDailyDigestToRemoteAgents: vi.fn(),
  saveDailyDigest: vi.fn(),
}));
vi.mock("@/utils/a2a/digest-report", () => ({
  alertDigestFailure: vi.fn(),
  findOwnerMessagingChannel: vi.fn(),
  recordDigestRun: vi.fn(),
}));
vi.mock("@/utils/automation-jobs/messaging", () => ({
  sendAutomationMessage: vi.fn(),
}));
vi.mock("@/utils/morning-report/build", () => ({ markReportSent: vi.fn() }));
vi.mock("@/utils/mqtt/events", () => ({ publishDigest: vi.fn() }));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});

import { GET } from "./route";

const URL_ = "http://localhost:3000/api/cron/a2a-digest";

describe("a2a-digest cron route", () => {
  beforeEach(() => {
    prisma.user.findMany.mockResolvedValue([]);
  });

  it("rejects a request without the cron secret", async () => {
    const response = await GET(new Request(URL_));
    expect(response.status).toBe(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it("answers 2xx with the cron secret", async () => {
    const response = await GET(
      new Request(URL_, { headers: { authorization: "Bearer cron-secret" } }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: 0,
      owners: 0,
      generated: 0,
      skipped: 0,
      failed: 0,
    });
  });
});
