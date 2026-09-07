import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { A2aAuthContext } from "./auth";

const logger = createScopedLogger("a2a-rate-limit");

/**
 * Rate limit configuration
 * These are initial conservative limits - adjust based on usage patterns
 */
export const RATE_LIMITS = {
  // Per-client limits (based on OAuth client_id)
  CLIENT_PER_MINUTE: 60, // 60 requests per minute per client
  CLIENT_PER_HOUR: 1000, // 1000 requests per hour per client

  // Per-user limits (based on userId)
  USER_PER_MINUTE: 100, // 100 requests per minute per user
  USER_PER_HOUR: 2000, // 2000 requests per hour per user

  // Per-IP limits (for unauthenticated requests)
  IP_PER_MINUTE: 20, // 20 requests per minute per IP
  IP_PER_HOUR: 200, // 200 requests per hour per IP

  // Task creation limits (more restrictive for expensive operations)
  TASK_CREATE_PER_MINUTE: 30,
  TASK_CREATE_PER_HOUR: 500,

  // Tasks that interrupt a HUMAN. The scarce resource here is not CPU, it is
  // the reviewer's attention: under the task-creation limits a peer could raise
  // 500 approval prompts an hour, and an approver buried in prompts starts
  // approving without reading. That is a denial-of-oversight attack, and it
  // defeats the gate behaviourally while it still holds on paper. Generous
  // enough for someone scheduling a day of meetings, tight enough that a flood
  // stops long before it wears anyone down.
  APPROVAL_PER_MINUTE: 5,
  APPROVAL_PER_HOUR: 20,

  // Cleanup configuration
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000, // 1 hour
  CLEANUP_OLDER_THAN_HOURS: 24, // Keep records for 24 hours
} as const;

/**
 * Rate limit result
 */
export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfter?: number; // Seconds to wait before retry
}

/**
 * Rate limit window
 */
type RateLimitWindow = "minute" | "hour";

/**
 * Check rate limit for a specific key and window
 *
 * @param key - Unique identifier (e.g., "client:abc123", "user:xyz789")
 * @param window - Time window ("minute" or "hour")
 * @param limit - Maximum requests allowed in this window
 * @returns Rate limit result
 */
export async function checkRateLimit(
  key: string,
  window: RateLimitWindow,
  limit: number,
): Promise<RateLimitResult> {
  const now = new Date();

  // key format: "client:abc123", "user:xyz789", "ip:1.2.3.4",
  // or a scoped bucket like "client:abc123:task"
  const { limitType, identifier } = parseRateLimitKey(key);
  const { windowStart, windowEnd } = getWindowBounds(window, now);

  // Match the bucket `recordRequest` writes, exactly. A range match on
  // windowEnd cannot work here: the active bucket's windowEnd is in the
  // future, and minute and hour buckets share a (limitType, identifier).
  const whereClause: Record<string, unknown> = {
    limitType,
    windowStart,
    windowEnd,
  };

  // Add identifier field based on type
  if (limitType === "client") {
    whereClause.clientId = identifier;
  } else if (limitType === "user") {
    whereClause.userId = identifier;
  } else if (limitType === "ip") {
    whereClause.ipAddress = identifier;
  }

  // Summed rather than read from one row: the unique constraint includes
  // nullable columns, and Postgres treats NULLs as distinct, so concurrent
  // writers can still create more than one row per bucket.
  const records = await prisma.a2aRateLimit.findMany({
    where: whereClause as never,
  });

  const count = records.reduce((sum, record) => sum + record.requestCount, 0);

  const remaining = Math.max(0, limit - count);
  const allowed = count < limit;

  // Calculate reset time (end of current window)
  const resetAt =
    window === "minute"
      ? new Date(Math.ceil(now.getTime() / 60_000) * 60_000) // Next minute boundary
      : new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000); // Next hour boundary

  const result: RateLimitResult = {
    allowed,
    remaining,
    resetAt,
    limit,
  };

  if (!allowed) {
    // Calculate seconds until reset
    result.retryAfter = Math.ceil((resetAt.getTime() - now.getTime()) / 1000);

    logger.warn("Rate limit exceeded", {
      key,
      window,
      count,
      limit,
      retryAfter: result.retryAfter,
    });
  }

  return result;
}

/**
 * Record a request for rate limiting
 * Should be called after checkRateLimit returns allowed=true
 *
 * @param key - Unique identifier (format: "type:identifier")
 * @param window - Time window
 */
export async function recordRequest(
  key: string,
  window: RateLimitWindow,
): Promise<void> {
  const now = new Date();
  const { limitType, identifier } = parseRateLimitKey(key);
  const { windowStart, windowEnd } = getWindowBounds(window, now);

  // Build data object based on limitType
  const data: Record<string, unknown> = {
    limitType,
    windowStart,
    windowEnd,
    requestCount: 1,
  };

  if (limitType === "client") {
    data.clientId = identifier;
  } else if (limitType === "user") {
    data.userId = identifier;
  } else if (limitType === "ip") {
    data.ipAddress = identifier;
  }

  // Try to increment existing record or create new one
  const existing = await prisma.a2aRateLimit.findFirst({
    where: {
      limitType,
      ...(limitType === "client" && { clientId: identifier }),
      ...(limitType === "user" && { userId: identifier }),
      ...(limitType === "ip" && { ipAddress: identifier }),
      windowStart,
      windowEnd,
    },
  });

  if (existing) {
    await prisma.a2aRateLimit.update({
      where: { id: existing.id },
      data: {
        requestCount: { increment: 1 },
      },
    });
  } else {
    await prisma.a2aRateLimit.create({
      data: data as never,
    });
  }
}

/**
 * Check and record rate limit in one operation
 * Convenience function that combines checkRateLimit and recordRequest
 *
 * @param key - Unique identifier
 * @param window - Time window
 * @param limit - Maximum requests allowed
 * @returns Rate limit result
 */
export async function checkAndRecordRateLimit(
  key: string,
  window: RateLimitWindow,
  limit: number,
): Promise<RateLimitResult> {
  const result = await checkRateLimit(key, window, limit);

  if (result.allowed) {
    await recordRequest(key, window);
  }

  return result;
}

/**
 * Check rate limits for an authenticated A2A request
 * Checks both client-level and user-level rate limits
 *
 * @param context - Authentication context
 * @param operation - Type of operation ("request" or "task_create")
 * @returns Rate limit result (returns first limit that fails)
 */
export async function checkA2aRequestRateLimit(
  context: A2aAuthContext,
  operation: "request" | "task_create" | "approval_request" = "request",
): Promise<RateLimitResult> {
  const { clientId, userId } = context;

  if (operation === "approval_request") {
    const minute = await checkAndRecordRateLimit(
      `client:${clientId}:approval`,
      "minute",
      RATE_LIMITS.APPROVAL_PER_MINUTE,
    );
    if (!minute.allowed) return minute;

    return checkAndRecordRateLimit(
      `client:${clientId}:approval`,
      "hour",
      RATE_LIMITS.APPROVAL_PER_HOUR,
    );
  }

  if (operation === "task_create") {
    // More restrictive limits for task creation
    // Check per-minute limit
    const clientMinuteResult = await checkRateLimit(
      `client:${clientId}:task`,
      "minute",
      RATE_LIMITS.TASK_CREATE_PER_MINUTE,
    );

    if (!clientMinuteResult.allowed) {
      return clientMinuteResult;
    }

    // Check per-hour limit
    const clientHourResult = await checkRateLimit(
      `client:${clientId}:task`,
      "hour",
      RATE_LIMITS.TASK_CREATE_PER_HOUR,
    );

    if (!clientHourResult.allowed) {
      return clientHourResult;
    }

    // Record the request
    await recordRequest(`client:${clientId}:task`, "minute");
    await recordRequest(`client:${clientId}:task`, "hour");

    return clientMinuteResult; // Return minute limit info (more restrictive)
  }

  // Standard request limits
  // Check client per-minute limit
  const clientMinuteResult = await checkRateLimit(
    `client:${clientId}`,
    "minute",
    RATE_LIMITS.CLIENT_PER_MINUTE,
  );

  if (!clientMinuteResult.allowed) {
    return clientMinuteResult;
  }

  // Check client per-hour limit
  const clientHourResult = await checkRateLimit(
    `client:${clientId}`,
    "hour",
    RATE_LIMITS.CLIENT_PER_HOUR,
  );

  if (!clientHourResult.allowed) {
    return clientHourResult;
  }

  // Check user per-minute limit
  const userMinuteResult = await checkRateLimit(
    `user:${userId}`,
    "minute",
    RATE_LIMITS.USER_PER_MINUTE,
  );

  if (!userMinuteResult.allowed) {
    return userMinuteResult;
  }

  // Check user per-hour limit
  const userHourResult = await checkRateLimit(
    `user:${userId}`,
    "hour",
    RATE_LIMITS.USER_PER_HOUR,
  );

  if (!userHourResult.allowed) {
    return userHourResult;
  }

  // Record the requests
  await recordRequest(`client:${clientId}`, "minute");
  await recordRequest(`client:${clientId}`, "hour");
  await recordRequest(`user:${userId}`, "minute");
  await recordRequest(`user:${userId}`, "hour");

  // Return the most restrictive remaining count
  const minRemaining = Math.min(
    clientMinuteResult.remaining,
    clientHourResult.remaining,
    userMinuteResult.remaining,
    userHourResult.remaining,
  );

  return {
    ...clientMinuteResult,
    remaining: minRemaining,
  };
}

/**
 * Check rate limit for unauthenticated requests (by IP address)
 *
 * @param ipAddress - Client IP address
 * @returns Rate limit result
 */
export async function checkIpRateLimit(
  ipAddress: string,
): Promise<RateLimitResult> {
  // Check per-minute limit
  const minuteResult = await checkRateLimit(
    `ip:${ipAddress}`,
    "minute",
    RATE_LIMITS.IP_PER_MINUTE,
  );

  if (!minuteResult.allowed) {
    return minuteResult;
  }

  // Check per-hour limit
  const hourResult = await checkRateLimit(
    `ip:${ipAddress}`,
    "hour",
    RATE_LIMITS.IP_PER_HOUR,
  );

  if (!hourResult.allowed) {
    return hourResult;
  }

  // Record the requests
  await recordRequest(`ip:${ipAddress}`, "minute");
  await recordRequest(`ip:${ipAddress}`, "hour");

  return minuteResult;
}

/**
 * Clean up old rate limit records
 * Should be called periodically (e.g., via cron job or background task)
 */
export async function cleanupRateLimitRecords(): Promise<number> {
  const cutoffDate = new Date(
    Date.now() - RATE_LIMITS.CLEANUP_OLDER_THAN_HOURS * 60 * 60 * 1000,
  );

  const result = await prisma.a2aRateLimit.deleteMany({
    where: {
      windowEnd: {
        lt: cutoffDate,
      },
    },
  });

  logger.info("Cleaned up old rate limit records", {
    deletedCount: result.count,
    cutoffDate,
  });

  return result.count;
}

/**
 * Get rate limit headers for HTTP responses
 * Following standard rate limit header conventions
 *
 * @param result - Rate limit result
 * @returns Headers object
 */
export function getRateLimitHeaders(
  result: RateLimitResult,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": result.limit.toString(),
    "X-RateLimit-Remaining": result.remaining.toString(),
    "X-RateLimit-Reset": Math.floor(result.resetAt.getTime() / 1000).toString(),
  };

  if (result.retryAfter !== undefined) {
    headers["Retry-After"] = result.retryAfter.toString();
  }

  return headers;
}

/**
 * Create a rate limit exceeded error response
 * Following OAuth 2.0 error response format
 */
export function createRateLimitResponse(result: RateLimitResult) {
  return {
    status: 429,
    headers: getRateLimitHeaders(result),
    body: {
      error: "rate_limit_exceeded",
      error_description: `Rate limit exceeded. Retry after ${result.retryAfter} seconds.`,
      retry_after: result.retryAfter,
      limit: result.limit,
      remaining: result.remaining,
      reset_at: result.resetAt.toISOString(),
    },
  };
}

/**
 * Extract client IP address from request
 * Handles various proxy headers
 *
 * @param request - Next.js request object
 * @returns Client IP address
 */
export function getClientIp(request: Request): string {
  // Try various headers in order of preference
  const headers = [
    "x-forwarded-for", // Standard proxy header
    "x-real-ip", // Nginx
    "cf-connecting-ip", // Cloudflare
    "fastly-client-ip", // Fastly
    "x-client-ip", // Generic
  ];

  for (const header of headers) {
    const value = request.headers.get(header);
    if (value) {
      // x-forwarded-for can be a comma-separated list, take the first IP
      const ip = value.split(",")[0]?.trim();
      if (ip) {
        return ip;
      }
    }
  }

  // Fallback to a default IP if we can't determine it
  return "unknown";
}

/**
 * Fixed bucket boundaries for a window. Readers and writers must agree on
 * these exactly, or a check never sees the requests it is meant to count.
 */
function getWindowBounds(window: RateLimitWindow, now: Date) {
  const size = window === "minute" ? 60_000 : 3_600_000;
  const windowStart = new Date(Math.floor(now.getTime() / size) * size);

  return { windowStart, windowEnd: new Date(windowStart.getTime() + size) };
}

/**
 * Split a bucket key into its type and identifier.
 *
 * Everything after the first ":" is the identifier, so a scoped bucket like
 * "client:abc:task" stays separate from "client:abc". Destructuring
 * `key.split(":")` instead silently merged the two into one counter.
 */
function parseRateLimitKey(key: string) {
  const separatorIndex = key.indexOf(":");

  if (separatorIndex === -1) return { limitType: key, identifier: "" };

  return {
    limitType: key.slice(0, separatorIndex),
    identifier: key.slice(separatorIndex + 1),
  };
}
