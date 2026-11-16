import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: { CRON_SECRET: "cron-secret" } }));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));
vi.mock("@/utils/a2a/task-executor", () => ({ executeTask: vi.fn() }));
vi.mock("@/utils/a2a/rate-limit", () => ({
  cleanupRateLimitRecords: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/utils/a2a/token-hygiene", () => ({
  cleanupExpiredAccessTokens: vi.fn().mockResolvedValue(0),
  reportA2aTokenHygiene: vi
    .fn()
    .mockResolvedValue({ checked: 0, findings: [] }),
}));
vi.mock("@/utils/mqtt/events", () => ({
  publishServiceHealth: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/a2a/dharahil-integration", () => ({
  processPendingDharaHILApprovals: vi.fn(),
  processExpiredDharaHILApprovals: vi.fn(),
}));
vi.mock("@/utils/a2a/webhooks", () => ({
  processPendingWebhooks: vi
    .fn()
    .mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 }),
  cleanupOldWebhookDeliveries: vi.fn().mockResolvedValue(0),
  cleanupOrphanedTaskWebhookConfigs: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});

import { GET } from "./route";

const URL_ = "http://localhost:3000/api/cron/a2a-tasks";

describe("a2a-tasks cron route", () => {
  beforeEach(() => {
    prisma.a2aTask.findMany.mockResolvedValue([]);
  });

  it("rejects a request without the cron secret", async () => {
    const response = await GET(new Request(URL_));
    expect(response.status).toBe(401);
    expect(prisma.a2aTask.findMany).not.toHaveBeenCalled();
  });

  it("answers 2xx with the cron secret", async () => {
    const response = await GET(
      new Request(URL_, { headers: { authorization: "Bearer cron-secret" } }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pending).toEqual({
      found: 0,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
  });
});
