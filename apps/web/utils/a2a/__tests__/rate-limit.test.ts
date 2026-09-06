import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMITS,
  checkA2aRequestRateLimit,
  checkAndRecordRateLimit,
  checkIpRateLimit,
  checkRateLimit,
  cleanupRateLimitRecords,
  getRateLimitHeaders,
  recordRequest,
} from "../rate-limit";
import type { A2aAuthContext } from "../auth";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: {
    a2aRateLimit: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);
const rateLimit = prisma.a2aRateLimit as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  deleteMany: ReturnType<typeof vi.fn>;
};

/** Stored rows only ever hold a count; the bucket comes from the where clause. */
function rows(...counts: number[]) {
  return counts.map((requestCount) => ({ id: "row", requestCount }));
}

const mockAuthContext: A2aAuthContext = {
  userId: "user-123",
  emailAccountId: "email-account-456",
  clientId: "client-789",
  scopes: ["email:read"],
  tokenPayload: {
    sub: "user-123",
    email: "test@example.com",
    email_account_id: "email-account-456",
    scope: "email:read",
    client_id: "client-789",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: "token-jti-123",
    token_type: "access",
  },
};

describe("A2A Rate Limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.findMany.mockResolvedValue([]);
    rateLimit.findFirst.mockResolvedValue(null);
    rateLimit.create.mockResolvedValue({});
    rateLimit.update.mockResolvedValue({});
    rateLimit.deleteMany.mockResolvedValue({ count: 0 });
  });

  describe("checkRateLimit", () => {
    it("allows requests under the limit", async () => {
      rateLimit.findMany.mockResolvedValue(rows(10));

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
      expect(result.limit).toBe(60);
    });

    it("blocks requests at the limit", async () => {
      rateLimit.findMany.mockResolvedValue(rows(60));

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("sums duplicate rows for the same bucket", async () => {
      // The unique constraint spans nullable columns, and Postgres treats
      // NULLs as distinct, so concurrent writers can produce several rows.
      rateLimit.findMany.mockResolvedValue(rows(30, 25, 10));

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.allowed).toBe(false);
    });

    it("resets at the next window boundary", async () => {
      const nextMinute = new Date(Math.ceil(Date.now() / 60_000) * 60_000);

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.resetAt).toEqual(nextMinute);
    });

    // Regression: checkRateLimit used to filter `windowEnd: { lte: now }`,
    // but recordRequest writes the active bucket's windowEnd in the FUTURE.
    // The current window was therefore never counted and nothing was limited.
    it("queries the same bucket recordRequest writes", async () => {
      await recordRequest("client:test-client", "minute");
      const written = rateLimit.create.mock.calls[0][0].data;

      await checkRateLimit("client:test-client", "minute", 60);
      const queried = rateLimit.findMany.mock.calls[0][0].where;

      expect(queried.windowStart).toEqual(written.windowStart);
      expect(queried.windowEnd).toEqual(written.windowEnd);
      expect(queried.clientId).toBe(written.clientId);
    });

    it("keeps minute and hour buckets separate", async () => {
      await checkRateLimit("client:test-client", "minute", 60);
      await checkRateLimit("client:test-client", "hour", 1000);

      const [minute, hour] = rateLimit.findMany.mock.calls.map(
        (call) => call[0].where,
      );

      expect(minute.windowEnd).not.toEqual(hour.windowEnd);
    });

    // Regression: `const [limitType, identifier] = key.split(":")` dropped the
    // ":task" suffix, so task-creation limits shared the client's counter.
    it("keeps a scoped bucket separate from its parent", async () => {
      await checkRateLimit("client:test-client", "minute", 60);
      await checkRateLimit("client:test-client:task", "minute", 30);

      const [plain, scoped] = rateLimit.findMany.mock.calls.map(
        (call) => call[0].where,
      );

      expect(plain.clientId).toBe("test-client");
      expect(scoped.clientId).toBe("test-client:task");
    });

    it("routes each limit type to its own column", async () => {
      await checkRateLimit("user:u1", "minute", 60);
      await checkRateLimit("ip:1.2.3.4", "minute", 60);

      const [user, ip] = rateLimit.findMany.mock.calls.map(
        (call) => call[0].where,
      );

      expect(user).toMatchObject({ limitType: "user", userId: "u1" });
      expect(ip).toMatchObject({ limitType: "ip", ipAddress: "1.2.3.4" });
    });
  });

  describe("recordRequest", () => {
    it("creates a bucket row when none exists", async () => {
      await recordRequest("client:test-client", "minute");

      expect(rateLimit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          limitType: "client",
          clientId: "test-client",
          requestCount: 1,
          windowStart: expect.any(Date),
          windowEnd: expect.any(Date),
        }),
      });
    });

    it("increments instead of duplicating when the bucket exists", async () => {
      rateLimit.findFirst.mockResolvedValue({ id: "existing" });

      await recordRequest("client:test-client", "minute");

      expect(rateLimit.create).not.toHaveBeenCalled();
      expect(rateLimit.update).toHaveBeenCalledWith({
        where: { id: "existing" },
        data: { requestCount: { increment: 1 } },
      });
    });
  });

  describe("checkAndRecordRateLimit", () => {
    it("records the request when allowed", async () => {
      rateLimit.findMany.mockResolvedValue(rows(10));

      const result = await checkAndRecordRateLimit(
        "client:test-client",
        "minute",
        60,
      );

      expect(result.allowed).toBe(true);
      expect(rateLimit.create).toHaveBeenCalled();
    });

    it("does not record the request when blocked", async () => {
      rateLimit.findMany.mockResolvedValue(rows(60));

      const result = await checkAndRecordRateLimit(
        "client:test-client",
        "minute",
        60,
      );

      expect(result.allowed).toBe(false);
      expect(rateLimit.create).not.toHaveBeenCalled();
    });
  });

  describe("checkA2aRequestRateLimit", () => {
    it("checks client and user, per minute and per hour", async () => {
      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(true);
      expect(rateLimit.findMany).toHaveBeenCalledTimes(4);
    });

    it("blocks on the user limit even when the client is under", async () => {
      rateLimit.findMany
        .mockResolvedValueOnce(rows(10))
        .mockResolvedValueOnce(rows(10))
        .mockResolvedValueOnce(rows(RATE_LIMITS.USER_PER_MINUTE));

      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(false);
      expect(rateLimit.create).not.toHaveBeenCalled();
    });

    it("reports the most restrictive remaining count", async () => {
      rateLimit.findMany
        .mockResolvedValueOnce(rows(50)) // client/minute -> 10 left
        .mockResolvedValueOnce(rows(900)) // client/hour   -> 100 left
        .mockResolvedValueOnce(rows(95)) // user/minute   -> 5 left
        .mockResolvedValueOnce(rows(1500)); // user/hour  -> 500 left

      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5);
    });

    it("uses the task bucket for task creation", async () => {
      await checkA2aRequestRateLimit(mockAuthContext, "task_create");

      expect(rateLimit.findMany.mock.calls[0][0].where).toMatchObject({
        limitType: "client",
        clientId: "client-789:task",
      });
    });

    it("enforces the stricter task-creation limit", async () => {
      rateLimit.findMany.mockResolvedValue(
        rows(RATE_LIMITS.TASK_CREATE_PER_MINUTE),
      );

      const result = await checkA2aRequestRateLimit(
        mockAuthContext,
        "task_create",
      );

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(RATE_LIMITS.TASK_CREATE_PER_MINUTE);
    });
  });

  describe("checkIpRateLimit", () => {
    it("allows an IP under the limit", async () => {
      rateLimit.findMany.mockResolvedValue(rows(10));

      const result = await checkIpRateLimit("192.168.1.100");

      expect(result.allowed).toBe(true);
      expect(rateLimit.findMany.mock.calls[0][0].where).toMatchObject({
        limitType: "ip",
        ipAddress: "192.168.1.100",
      });
    });

    it("blocks an IP at the per-minute limit", async () => {
      rateLimit.findMany.mockResolvedValue(rows(RATE_LIMITS.IP_PER_MINUTE));

      const result = await checkIpRateLimit("192.168.1.100");

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(RATE_LIMITS.IP_PER_MINUTE);
    });
  });

  describe("cleanupRateLimitRecords", () => {
    // Regression: this filtered on `timestamp`, a column A2aRateLimit does not
    // have, so every cleanup run threw and the table grew without bound.
    it("deletes by a column that exists on the model", async () => {
      rateLimit.deleteMany.mockResolvedValue({ count: 7 });

      const deleted = await cleanupRateLimitRecords();

      expect(deleted).toBe(7);
      expect(rateLimit.deleteMany).toHaveBeenCalledWith({
        where: { windowEnd: { lt: expect.any(Date) } },
      });
    });
  });

  describe("getRateLimitHeaders", () => {
    it("omits Retry-After while requests are still allowed", () => {
      const headers = getRateLimitHeaders({
        allowed: true,
        limit: 60,
        remaining: 42,
        resetAt: new Date(0),
      });

      expect(headers["X-RateLimit-Limit"]).toBe("60");
      expect(headers["X-RateLimit-Remaining"]).toBe("42");
      expect(headers["Retry-After"]).toBeUndefined();
    });

    it("includes Retry-After once blocked", () => {
      const headers = getRateLimitHeaders({
        allowed: false,
        limit: 60,
        remaining: 0,
        resetAt: new Date(0),
        retryAfter: 30,
      });

      expect(headers["Retry-After"]).toBe("30");
    });
  });
});
