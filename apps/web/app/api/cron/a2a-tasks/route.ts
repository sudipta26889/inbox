import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { A2aTaskState } from "@prisma/client";
import { executeTask } from "@/utils/a2a/task-executor";
import { cleanupRateLimitRecords } from "@/utils/a2a/rate-limit";
import {
  processPendingDharaHILApprovals,
  processExpiredDharaHILApprovals,
} from "@/utils/a2a/dharahil-integration";
import {
  processPendingWebhooks,
  cleanupOldWebhookDeliveries,
} from "@/utils/a2a/webhooks";

export const maxDuration = 300;

/**
 * A2A Task Processor Cron Job
 *
 * This endpoint is called periodically to:
 * 1. Process pending tasks in submitted state
 * 2. Poll for DharaHIL approval decisions
 * 3. Process expired DharaHIL approvals
 * 4. Timeout tasks that have been running too long
 * 5. Clean up old rate limit records
 *
 * Should be called every 1-5 minutes via cron (e.g., Vercel Cron, QStash)
 */

const BATCH_SIZE = 20; // Process up to 20 tasks per run
const TASK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const _CLEANUP_INTERVAL_HOURS = 1; // Clean rate limits every hour

export const GET = withError("cron/a2a-tasks", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/cron/a2a-tasks"));
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await processA2aTasks(request.logger);
  return NextResponse.json(result);
});

export const POST = withError("cron/a2a-tasks", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/a2a-tasks"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await processA2aTasks(request.logger);
  return NextResponse.json(result);
});

async function processA2aTasks(logger: Logger) {
  const now = new Date();

  // Step 1: Process pending tasks
  const pendingResult = await processPendingTasks(logger);

  // Step 2: Poll for DharaHIL approval decisions
  const dharahilResult = await processDharaHILApprovals(logger);

  // Step 3: Process expired DharaHIL approvals
  const expiredResult = await processExpiredApprovals(logger);

  // Step 4: Deliver pending webhooks
  const webhooksResult = await processWebhooks(logger);

  // Step 5: Timeout stuck tasks
  const timeoutResult = await timeoutStuckTasks(logger, now);

  // Step 6: Clean up old records (once per hour)
  const cleanupResult = await cleanupOldRecords(logger);

  logger.info("Finished A2A task processing", {
    pending: pendingResult,
    dharahil: dharahilResult,
    expired: expiredResult,
    webhooks: webhooksResult,
    timeouts: timeoutResult,
    cleanup: cleanupResult,
  });

  return {
    pending: pendingResult,
    dharahil: dharahilResult,
    expired: expiredResult,
    webhooks: webhooksResult,
    timeouts: timeoutResult,
    cleanup: cleanupResult,
  };
}

/**
 * Process tasks in submitted state
 */
async function processPendingTasks(logger: Logger) {
  const pendingTasks = await prisma.a2aTask.findMany({
    where: {
      state: A2aTaskState.submitted,
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      taskId: true,
      skill: true,
      userId: true,
      clientId: true,
    },
  });

  logger.info("Found pending A2A tasks", { count: pendingTasks.length });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const task of pendingTasks) {
    const taskLogger = logger.with({
      taskId: task.taskId,
      skill: task.skill,
      userId: task.userId,
      clientId: task.clientId,
    });

    try {
      await executeTask(task.id);
      processed++;

      // Check final state
      const updatedTask = await prisma.a2aTask.findUnique({
        where: { id: task.id },
        select: { state: true },
      });

      if (updatedTask?.state === A2aTaskState.completed) {
        succeeded++;
      } else if (updatedTask?.state === A2aTaskState.failed) {
        failed++;
      }

      taskLogger.info("Processed A2A task", {
        finalState: updatedTask?.state,
      });
    } catch (error: unknown) {
      failed++;
      taskLogger.error("Failed to process A2A task", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Mark task as failed
      try {
        await prisma.a2aTask.update({
          where: { id: task.id },
          data: {
            state: A2aTaskState.failed,
            stateReason: `Processor error: ${error.message}`,
            error: {
              message: error.message,
              stack: error.stack,
            },
            completedAt: new Date(),
          },
        });

        // Record state transition
        await prisma.a2aTaskHistory.create({
          data: {
            taskId: task.id,
            fromState: A2aTaskState.submitted,
            toState: A2aTaskState.failed,
            reason: `Processor error: ${error.message}`,
          },
        });
      } catch (updateError: unknown) {
        taskLogger.error("Failed to mark task as failed", {
          error:
            updateError instanceof Error
              ? updateError.message
              : String(updateError),
        });
      }
    }
  }

  return {
    found: pendingTasks.length,
    processed,
    succeeded,
    failed,
  };
}

/**
 * Timeout tasks that have been in working state for too long
 */
async function timeoutStuckTasks(logger: Logger, now: Date) {
  const timeoutThreshold = new Date(now.getTime() - TASK_TIMEOUT_MS);

  const stuckTasks = await prisma.a2aTask.findMany({
    where: {
      state: A2aTaskState.working,
      updatedAt: {
        lt: timeoutThreshold,
      },
    },
    select: {
      id: true,
      taskId: true,
      skill: true,
      updatedAt: true,
    },
  });

  logger.info("Found stuck A2A tasks", { count: stuckTasks.length });

  let timedOut = 0;

  for (const task of stuckTasks) {
    const taskLogger = logger.with({
      taskId: task.taskId,
      skill: task.skill,
    });

    try {
      const ageMs = now.getTime() - task.updatedAt.getTime();

      await prisma.a2aTask.update({
        where: { id: task.id },
        data: {
          state: A2aTaskState.failed,
          stateReason: `Task timeout after ${Math.round(ageMs / 1000)}s`,
          error: {
            code: "TASK_TIMEOUT",
            message: `Task exceeded maximum execution time of ${TASK_TIMEOUT_MS / 1000}s`,
            ageMs,
          },
          completedAt: now,
        },
      });

      // Record state transition
      await prisma.a2aTaskHistory.create({
        data: {
          taskId: task.id,
          fromState: A2aTaskState.working,
          toState: A2aTaskState.failed,
          reason: `Task timeout after ${Math.round(ageMs / 1000)}s`,
          durationMs: ageMs,
        },
      });

      timedOut++;
      taskLogger.info("Timed out stuck A2A task", { ageMs });
    } catch (error: unknown) {
      taskLogger.error("Failed to timeout stuck task", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    found: stuckTasks.length,
    timedOut,
  };
}

/**
 * Process pending DharaHIL approvals
 */
async function processDharaHILApprovals(logger: Logger) {
  try {
    await processPendingDharaHILApprovals();
    return { processed: true };
  } catch (error: unknown) {
    logger.error("Failed to process DharaHIL approvals", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { processed: false, error: error.message };
  }
}

/**
 * Process expired DharaHIL approvals
 */
async function processExpiredApprovals(logger: Logger) {
  try {
    await processExpiredDharaHILApprovals();
    return { processed: true };
  } catch (error: unknown) {
    logger.error("Failed to process expired approvals", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { processed: false, error: error.message };
  }
}

/**
 * Process pending webhooks
 */
async function processWebhooks(logger: Logger) {
  try {
    const result = await processPendingWebhooks();
    logger.info("Processed pending webhooks", result);
    return result;
  } catch (error: unknown) {
    logger.error("Failed to process webhooks", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { processed: 0, succeeded: 0, failed: 0, error: error.message };
  }
}

/**
 * Clean up old records (rate limits + webhook deliveries)
 */
async function cleanupOldRecords(logger: Logger) {
  try {
    const [rateLimitsDeleted, webhooksDeleted] = await Promise.all([
      cleanupRateLimitRecords(),
      cleanupOldWebhookDeliveries(30), // Keep 30 days of webhook history
    ]);

    logger.info("Cleaned up old records", {
      rateLimitsDeleted,
      webhooksDeleted,
    });

    return {
      rateLimitsDeleted,
      webhooksDeleted,
    };
  } catch (error: unknown) {
    logger.error("Failed to clean up old records", {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      rateLimitsDeleted: 0,
      webhooksDeleted: 0,
      error: error.message,
    };
  }
}
