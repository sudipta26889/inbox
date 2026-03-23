import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkRateLimit,
  recordRequest,
  checkAndRecordRateLimit,
  checkA2aRequestRateLimit,
  checkIpRateLimit,
  cleanupRateLimitRecords,
  getRateLimitHeaders,
  RATE_LIMITS,
} from "../rate-limit";
import type { A2aAuthContext } from "../auth";

// Mock dependencies
vi.mock("@/utils/prisma", () => ({
  default: {
    a2aRateLimit: {
      count: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);

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
  });

  describe("checkRateLimit", () => {
    it("should allow requests under limit", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(10);

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(50);
      expect(result.limit).toBe(60);
    });

    it("should block requests over limit", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(60);

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it("should reset after time window", async () => {
      const now = new Date();
      const nextMinute = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);

      (prisma.a2aRateLimit.count as any).mockResolvedValue(0);

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(result.resetAt).toEqual(nextMinute);
    });

    it("should track per-minute limits", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(30);

      const result = await checkRateLimit("client:test-client", "minute", 60);

      expect(prisma.a2aRateLimit.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            window: "minute",
          }),
        }),
      );
    });

    it("should track per-hour limits", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(500);

      const result = await checkRateLimit("client:test-client", "hour", 1000);

      expect(prisma.a2aRateLimit.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            window: "hour",
          }),
        }),
      );
    });
  });

  describe("recordRequest", () => {
    it("should record request in database", async () => {
      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      await recordRequest("client:test-client", "minute");

      expect(prisma.a2aRateLimit.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          key: "client:test-client",
          window: "minute",
          timestamp: expect.any(Date),
        }),
      });
    });
  });

  describe("checkAndRecordRateLimit", () => {
    it("should record request if allowed", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(10);
      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      const result = await checkAndRecordRateLimit(
        "client:test-client",
        "minute",
        60,
      );

      expect(result.allowed).toBe(true);
      expect(prisma.a2aRateLimit.create).toHaveBeenCalled();
    });

    it("should NOT record request if blocked", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(60);

      const result = await checkAndRecordRateLimit(
        "client:test-client",
        "minute",
        60,
      );

      expect(result.allowed).toBe(false);
      expect(prisma.a2aRateLimit.create).not.toHaveBeenCalled();
    });
  });

  describe("Multi-tier Limits", () => {
    it("should enforce client-level limits", async () => {
      // Mock counts for different limits
      let callCount = 0;
      (prisma.a2aRateLimit.count as any).mockImplementation(() => {
        callCount++;
        // First 2 calls are client limits (minute, hour)
        if (callCount <= 2) return Promise.resolve(50); // Under limit
        // Next 2 calls are user limits
        return Promise.resolve(0);
      });

      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(true);
      // Should check client:minute, client:hour, user:minute, user:hour
      expect(prisma.a2aRateLimit.count).toHaveBeenCalledTimes(4);
    });

    it("should enforce user-level limits", async () => {
      let callCount = 0;
      (prisma.a2aRateLimit.count as any).mockImplementation(() => {
        callCount++;
        // Client limits pass
        if (callCount <= 2) return Promise.resolve(10);
        // User minute limit exceeded
        if (callCount === 3) return Promise.resolve(100);
        return Promise.resolve(0);
      });

      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(false);
    });

    it("should use most restrictive limit for remaining count", async () => {
      (prisma.a2aRateLimit.count as any).mockImplementation(
        ({ where }: any) => {
          if (where.key.includes("client") && where.window === "minute")
            return Promise.resolve(50); // 10 remaining
          if (where.key.includes("client") && where.window === "hour")
            return Promise.resolve(900); // 100 remaining
          if (where.key.includes("user") && where.window === "minute")
            return Promise.resolve(95); // 5 remaining (most restrictive)
          if (where.key.includes("user") && where.window === "hour")
            return Promise.resolve(1500); // 500 remaining
          return Promise.resolve(0);
        },
      );

      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      const result = await checkA2aRequestRateLimit(mockAuthContext, "request");

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(5); // Most restrictive
    });
  });

  describe("Task Creation Limits", () => {
    it("should apply stricter limits for task creation", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(0);
      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      await checkA2aRequestRateLimit(mockAuthContext, "task_create");

      // Should check with task creation limits
      expect(prisma.a2aRateLimit.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            key: "client:client-789:task",
          }),
        }),
      );
    });

    it("should enforce 30 req/min for task creation", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(30);

      const result = await checkA2aRequestRateLimit(
        mockAuthContext,
        "task_create",
      );

      expect(result.allowed).toBe(false);
    });
  });

  describe("IP-based Limits", () => {
    it("should enforce IP limits for unauthenticated requests", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(10);
      (prisma.a2aRateLimit.create as any).mockResolvedValue({});

      const result = await checkIpRateLimit("192.168.1.100");

      expect(result.allowed).toBe(true);
      expect(prisma.a2aRateLimit.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            key: "ip:192.168.1.100",
          }),
        }),
      );
    });

    it("should block IP after 20 req/min", async () => {
      (prisma.a2aRateLimit.count as any).mockResolvedValue(20);

      const result = await checkIpRateLimit("192.168.1.100");

      expect(result.allowed).toBe(false);
    });
  });

  describe("Cleanup", () => {
    it("should delete records older than 24 hours", async () => {
      (prisma.a2aRateLimit.deleteMany as any).mockResolvedValue({
        count: 1500,
      });

      const deletedCount = await cleanupRateLimitRecords();

      expect(deletedCount).toBe(1500);
      expect(prisma.a2aRateLimit.deleteMany).toHaveBeenCalledWith({
        where: {
          timestamp: {
            lt: expect.any(Date),
          },
        },
      });
    });
  });

  describe("Rate Limit Headers", () => {
    it("should return standard rate limit headers", () => {
      const result = {
        allowed: true,
        remaining: 50,
        resetAt: new Date("2026-03-24T10:00:00Z"),
        limit: 100,
      };

      const headers = getRateLimitHeaders(result);

      expect(headers["X-RateLimit-Limit"]).toBe("100");
      expect(headers["X-RateLimit-Remaining"]).toBe("50");
      expect(headers["X-RateLimit-Reset"]).toBe(
        String(Math.floor(result.resetAt.getTime() / 1000)),
      );
    });

    it("should include Retry-After header when blocked", () => {
      const result = {
        allowed: false,
        remaining: 0,
        resetAt: new Date(Date.now() + 60_000),
        limit: 100,
        retryAfter: 60,
      };

      const headers = getRateLimitHeaders(result);

      expect(headers["Retry-After"]).toBe("60");
    });
  });

  describe("Rate Limit Constants", () => {
    it("should have correct default limits", () => {
      expect(RATE_LIMITS.CLIENT_PER_MINUTE).toBe(60);
      expect(RATE_LIMITS.CLIENT_PER_HOUR).toBe(1000);
      expect(RATE_LIMITS.USER_PER_MINUTE).toBe(100);
      expect(RATE_LIMITS.USER_PER_HOUR).toBe(2000);
      expect(RATE_LIMITS.IP_PER_MINUTE).toBe(20);
      expect(RATE_LIMITS.IP_PER_HOUR).toBe(200);
      expect(RATE_LIMITS.TASK_CREATE_PER_MINUTE).toBe(30);
      expect(RATE_LIMITS.TASK_CREATE_PER_HOUR).toBe(500);
    });
  });
});
