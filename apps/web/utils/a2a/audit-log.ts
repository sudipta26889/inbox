import "server-only";
import { createScopedLogger } from "@/utils/logger";
import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("a2a-audit");

/**
 * A2A Audit Logging
 *
 * Comprehensive audit trail for all A2A operations for security, compliance, and debugging.
 * Logs: authentication attempts, task operations, approval decisions, rate limit violations.
 */

export type AuditEventType =
  | "auth.success"
  | "auth.failure"
  | "auth.token_refresh"
  | "task.created"
  | "task.executed"
  | "task.completed"
  | "task.failed"
  | "task.canceled"
  | "task.rejected"
  | "task.approved"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired"
  | "rate_limit.exceeded"
  | "webhook.configured"
  | "webhook.delivered"
  | "webhook.failed";

export interface AuditLogOptions {
  clientId?: string;
  durationMs?: number;
  endpoint?: string;
  errorMessage?: string;
  eventType: AuditEventType;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  success: boolean;
  taskId?: string;
  userAgent?: string;
  userId?: string;
}

/**
 * Create an audit log entry
 */
export async function logAuditEvent(options: AuditLogOptions): Promise<void> {
  try {
    // The column is `operation`, and it holds exactly these dotted event names
    // (see the model comment: "message.send", "task.cancel"). This module used
    // to write `eventType` and `endpoint`, neither of which exists, so every
    // create threw — and the catch below swallowed it. A2A auditing recorded
    // nothing at all.
    await prisma.a2aAuditLog.create({
      data: {
        operation: options.eventType,
        userId: options.userId,
        clientId: options.clientId,
        taskId: options.taskId,
        ipAddress: options.ipAddress,
        userAgent: options.userAgent,
        metadata: {
          ...options.metadata,
          ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        },
        success: options.success,
        errorMessage: options.errorMessage,
        durationMs: options.durationMs ?? 0,
      },
    });

    logger.info("Audit log created", {
      eventType: options.eventType,
      success: options.success,
      userId: options.userId,
      clientId: options.clientId,
    });
  } catch (error) {
    // Don't fail the operation if audit logging fails
    logger.error("Failed to create audit log", {
      eventType: options.eventType,
      error,
    });
  }
}

/**
 * Log authentication attempt
 */
export async function logAuthAttempt(
  clientId: string | null,
  success: boolean,
  ipAddress: string,
  userAgent?: string,
  errorMessage?: string,
): Promise<void> {
  await logAuditEvent({
    eventType: success ? "auth.success" : "auth.failure",
    clientId: clientId || undefined,
    ipAddress,
    userAgent,
    success,
    errorMessage,
  });
}

/**
 * Log task operation
 */
export async function logTaskOperation(
  eventType: AuditEventType,
  taskId: string,
  userId: string,
  clientId: string,
  success: boolean,
  metadata?: Record<string, unknown>,
  errorMessage?: string,
): Promise<void> {
  await logAuditEvent({
    eventType,
    userId,
    clientId,
    taskId,
    success,
    metadata,
    errorMessage,
  });
}

/**
 * Log approval decision
 */
export async function logApprovalDecision(
  taskId: string,
  userId: string,
  approved: boolean,
  approverId?: string,
  reason?: string,
): Promise<void> {
  await logAuditEvent({
    eventType: approved ? "approval.approved" : "approval.rejected",
    userId,
    taskId,
    success: true,
    metadata: {
      approved,
      approverId,
      reason,
    },
  });
}

/**
 * Log rate limit violation
 */
export async function logRateLimitExceeded(
  clientId: string | null,
  userId: string | null,
  ipAddress: string,
  limitType: string,
  endpoint: string,
): Promise<void> {
  await logAuditEvent({
    eventType: "rate_limit.exceeded",
    clientId: clientId || undefined,
    userId: userId || undefined,
    ipAddress,
    endpoint,
    success: false,
    metadata: {
      limitType,
    },
  });
}

/**
 * Get audit logs for a user
 */
export async function getUserAuditLogs(
  userId: string,
  options: {
    limit?: number;
    offset?: number;
    eventType?: AuditEventType;
    startDate?: Date;
    endDate?: Date;
  } = {},
) {
  const { limit = 100, offset = 0, eventType, startDate, endDate } = options;

  const where: Prisma.A2aAuditLogWhereInput = {
    userId,
    ...(eventType ? { operation: eventType } : {}),
    ...(startDate || endDate
      ? {
          timestamp: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.a2aAuditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.a2aAuditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    limit,
    offset,
  };
}

/**
 * Get audit logs for a client
 */
export async function getClientAuditLogs(
  clientId: string,
  options: {
    limit?: number;
    offset?: number;
    eventType?: AuditEventType;
    startDate?: Date;
    endDate?: Date;
  } = {},
) {
  const { limit = 100, offset = 0, eventType, startDate, endDate } = options;

  const where: Prisma.A2aAuditLogWhereInput = {
    clientId,
    ...(eventType ? { operation: eventType } : {}),
    ...(startDate || endDate
      ? {
          timestamp: {
            ...(startDate ? { gte: startDate } : {}),
            ...(endDate ? { lte: endDate } : {}),
          },
        }
      : {}),
  };

  const [logs, total] = await Promise.all([
    prisma.a2aAuditLog.findMany({
      where,
      orderBy: { timestamp: "desc" },
      take: limit,
      skip: offset,
    }),
    prisma.a2aAuditLog.count({ where }),
  ]);

  return {
    logs,
    total,
    limit,
    offset,
  };
}

/**
 * Get security summary for a client
 */
export async function getClientSecuritySummary(clientId: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalRequests,
    failedAuth,
    rateLimitViolations,
    tasksCreated,
    tasksCompleted,
    tasksFailed,
  ] = await Promise.all([
    prisma.a2aAuditLog.count({
      where: { clientId, timestamp: { gte: since } },
    }),
    prisma.a2aAuditLog.count({
      where: {
        clientId,
        timestamp: { gte: since },
        operation: "auth.failure",
      },
    }),
    prisma.a2aAuditLog.count({
      where: {
        clientId,
        timestamp: { gte: since },
        operation: "rate_limit.exceeded",
      },
    }),
    prisma.a2aAuditLog.count({
      where: {
        clientId,
        timestamp: { gte: since },
        operation: "task.created",
      },
    }),
    prisma.a2aAuditLog.count({
      where: {
        clientId,
        timestamp: { gte: since },
        operation: "task.completed",
      },
    }),
    prisma.a2aAuditLog.count({
      where: {
        clientId,
        timestamp: { gte: since },
        operation: "task.failed",
      },
    }),
  ]);

  return {
    period_days: days,
    total_requests: totalRequests,
    failed_auth_attempts: failedAuth,
    rate_limit_violations: rateLimitViolations,
    tasks_created: tasksCreated,
    tasks_completed: tasksCompleted,
    tasks_failed: tasksFailed,
    success_rate:
      tasksCreated > 0
        ? Math.round((tasksCompleted / tasksCreated) * 10_000) / 100
        : 0,
  };
}

/**
 * Clean up old audit logs (keep for compliance period)
 */
export async function cleanupOldAuditLogs(daysToKeep = 90): Promise<number> {
  const threshold = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

  const result = await prisma.a2aAuditLog.deleteMany({
    where: {
      timestamp: { lt: threshold },
    },
  });

  return result.count;
}
