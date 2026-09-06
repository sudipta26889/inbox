import "server-only";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { A2aTaskState, A2aWebhookStatus } from "@/generated/prisma/enums";
import crypto from "node:crypto";

const logger = createScopedLogger("a2a-webhooks");

/**
 * A2A Webhook Delivery System
 *
 * Implements reliable webhook delivery with:
 * - HMAC-SHA256 signature verification
 * - Exponential backoff retry logic
 * - Configurable events per client
 * - Delivery tracking and monitoring
 */

// Webhook events that can be subscribed to
export const WEBHOOK_EVENTS = {
  TASK_CREATED: "task.created",
  TASK_STATE_CHANGED: "task.state_changed",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TASK_CANCELED: "task.canceled",
  TASK_REJECTED: "task.rejected",
  TASK_APPROVAL_REQUIRED: "task.approval_required",
} as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[keyof typeof WEBHOOK_EVENTS];

// Retry configuration
const RETRY_DELAYS = [
  1000, // 1 second
  5000, // 5 seconds
  15_000, // 15 seconds
  60_000, // 1 minute
  300_000, // 5 minutes
];

const MAX_RETRIES = RETRY_DELAYS.length;

/**
 * Queue a webhook delivery for a task state change
 */
export async function queueWebhook(
  taskId: string,
  event: WebhookEvent,
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      taskId: true,
      clientId: true,
      userId: true,
      contextId: true,
      skill: true,
      input: true,
      state: true,
      stateReason: true,
      result: true,
      error: true,
      requiresApproval: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  });

  if (!task || !task.clientId) {
    logger.warn("Cannot queue webhook - task not found or no client ID", {
      taskId,
      event,
    });
    return;
  }

  // Get webhook configuration for this client
  const webhookConfig = await prisma.a2aWebhookConfig.findUnique({
    where: { clientId: task.clientId },
  });

  if (!webhookConfig || !webhookConfig.enabled) {
    logger.trace("No webhook configured for client", {
      clientId: task.clientId,
      event,
    });
    return;
  }

  // Check if this event is subscribed
  if (!webhookConfig.events.includes(event)) {
    logger.trace("Event not subscribed for client", {
      clientId: task.clientId,
      event,
      subscribedEvents: webhookConfig.events,
    });
    return;
  }

  // Build webhook payload
  const payload = buildWebhookPayload(task, event);

  // Generate HMAC signature
  const signature = generateSignature(payload, webhookConfig.secret);

  // Create delivery record
  await prisma.a2aWebhookDelivery.create({
    data: {
      taskId: task.id,
      clientId: task.clientId,
      url: webhookConfig.url,
      method: "POST",
      event,
      payload,
      signature,
      status: A2aWebhookStatus.pending,
      attempts: 0,
      maxAttempts: MAX_RETRIES,
      nextAttemptAt: new Date(), // Attempt immediately
    },
  });

  logger.info("Queued webhook delivery", {
    taskId: task.taskId,
    clientId: task.clientId,
    event,
    url: webhookConfig.url,
  });
}

/**
 * Build webhook payload from task data
 */
function buildWebhookPayload(task: any, event: WebhookEvent): any {
  return {
    event,
    timestamp: new Date().toISOString(),
    task: {
      id: task.taskId, // Public task ID
      context_id: task.contextId,
      skill: task.skill,
      input: task.input,
      state: task.state,
      state_reason: task.stateReason,
      result: task.result,
      error: task.error,
      requires_approval: task.requiresApproval,
      created_at: task.createdAt.toISOString(),
      updated_at: task.updatedAt.toISOString(),
      completed_at: task.completedAt?.toISOString(),
    },
  };
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
function generateSignature(payload: any, secret: string): string {
  const payloadString = JSON.stringify(payload);
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payloadString);
  return `sha256=${hmac.digest("hex")}`;
}

/**
 * Verify webhook signature
 */
export function verifySignature(
  payload: any,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = generateSignature(payload, secret);
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

/**
 * Deliver a pending webhook
 */
export async function deliverWebhook(deliveryId: string): Promise<boolean> {
  const delivery = await prisma.a2aWebhookDelivery.findUnique({
    where: { id: deliveryId },
  });

  if (!delivery || delivery.status !== A2aWebhookStatus.pending) {
    logger.warn("Webhook delivery not found or not pending", {
      deliveryId,
      status: delivery?.status,
    });
    return false;
  }

  logger.info("Attempting webhook delivery", {
    deliveryId,
    taskId: delivery.taskId,
    event: delivery.event,
    attempt: delivery.attempts + 1,
    maxAttempts: delivery.maxAttempts,
    url: delivery.url,
  });

  try {
    // Make HTTP request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10 second timeout

    const response = await fetch(delivery.url, {
      method: delivery.method,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "InboxZero-A2A-Webhook/1.0",
        "X-Webhook-Signature": delivery.signature || "",
        "X-Webhook-Event": delivery.event,
        "X-Webhook-Delivery-ID": delivery.id,
      },
      body: JSON.stringify(delivery.payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const responseBody = await response.text();

    // Update delivery record
    await prisma.a2aWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts: delivery.attempts + 1,
        lastAttemptAt: new Date(),
        responseStatus: response.status,
        responseBody: responseBody.substring(0, 10_000), // Limit to 10KB
        status: response.ok
          ? A2aWebhookStatus.delivered
          : A2aWebhookStatus.pending,
        deliveredAt: response.ok ? new Date() : undefined,
        nextAttemptAt: response.ok
          ? undefined
          : calculateNextAttempt(delivery.attempts + 1),
        errorMessage: response.ok
          ? undefined
          : `HTTP ${response.status}: ${responseBody.substring(0, 500)}`,
      },
    });

    if (response.ok) {
      logger.info("Webhook delivered successfully", {
        deliveryId,
        taskId: delivery.taskId,
        event: delivery.event,
        status: response.status,
      });
      return true;
    } else {
      logger.warn("Webhook delivery failed with HTTP error", {
        deliveryId,
        taskId: delivery.taskId,
        event: delivery.event,
        status: response.status,
        responseBody: responseBody.substring(0, 200),
      });

      // Check if we should mark as failed
      if (delivery.attempts + 1 >= delivery.maxAttempts) {
        await markWebhookFailed(deliveryId);
      }

      return false;
    }
  } catch (error: any) {
    logger.error("Webhook delivery error", {
      deliveryId,
      taskId: delivery.taskId,
      event: delivery.event,
      error: error.message,
      attempt: delivery.attempts + 1,
    });

    // Update delivery record
    await prisma.a2aWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        attempts: delivery.attempts + 1,
        lastAttemptAt: new Date(),
        errorMessage: error.message,
        nextAttemptAt: calculateNextAttempt(delivery.attempts + 1),
      },
    });

    // Check if we should mark as failed
    if (delivery.attempts + 1 >= delivery.maxAttempts) {
      await markWebhookFailed(deliveryId);
    }

    return false;
  }
}

/**
 * Calculate next attempt time with exponential backoff
 */
function calculateNextAttempt(attemptNumber: number): Date {
  const delay =
    RETRY_DELAYS[attemptNumber - 1] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  return new Date(Date.now() + delay);
}

/**
 * Mark webhook delivery as failed
 */
async function markWebhookFailed(deliveryId: string): Promise<void> {
  await prisma.a2aWebhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: A2aWebhookStatus.failed,
      nextAttemptAt: null,
    },
  });

  logger.error("Webhook delivery failed - max retries exceeded", {
    deliveryId,
  });
}

/**
 * Process pending webhook deliveries
 *
 * Should be called periodically (e.g., every minute from cron job)
 */
export async function processPendingWebhooks(): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const now = new Date();

  // Find deliveries ready for attempt
  const pendingDeliveries = await prisma.a2aWebhookDelivery.findMany({
    where: {
      status: A2aWebhookStatus.pending,
      nextAttemptAt: {
        lte: now,
      },
    },
    orderBy: { createdAt: "asc" },
    take: 50, // Process up to 50 deliveries per run
  });

  if (pendingDeliveries.length === 0) {
    logger.trace("No pending webhook deliveries to process");
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info("Processing pending webhook deliveries", {
    count: pendingDeliveries.length,
  });

  let succeeded = 0;
  let failed = 0;

  for (const delivery of pendingDeliveries) {
    const success = await deliverWebhook(delivery.id);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }
  }

  return {
    processed: pendingDeliveries.length,
    succeeded,
    failed,
  };
}

/**
 * Queue webhooks for task state transitions
 */
export async function queueWebhooksForStateChange(
  taskId: string,
  fromState: A2aTaskState,
  toState: A2aTaskState,
): Promise<void> {
  // Always send state_changed event
  await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_STATE_CHANGED);

  // Send specific events based on new state
  switch (toState) {
    case A2aTaskState.completed:
      await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_COMPLETED);
      break;

    case A2aTaskState.failed:
      await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_FAILED);
      break;

    case A2aTaskState.canceled:
      await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_CANCELED);
      break;

    case A2aTaskState.rejected:
      await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_REJECTED);
      break;

    case A2aTaskState.auth_required:
      await queueWebhook(taskId, WEBHOOK_EVENTS.TASK_APPROVAL_REQUIRED);
      break;
  }
}

/**
 * Get webhook delivery statistics for a client
 */
export async function getWebhookStats(clientId: string, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [total, delivered, failed, pending] = await Promise.all([
    prisma.a2aWebhookDelivery.count({
      where: {
        clientId,
        createdAt: { gte: since },
      },
    }),
    prisma.a2aWebhookDelivery.count({
      where: {
        clientId,
        createdAt: { gte: since },
        status: A2aWebhookStatus.delivered,
      },
    }),
    prisma.a2aWebhookDelivery.count({
      where: {
        clientId,
        createdAt: { gte: since },
        status: A2aWebhookStatus.failed,
      },
    }),
    prisma.a2aWebhookDelivery.count({
      where: {
        clientId,
        createdAt: { gte: since },
        status: A2aWebhookStatus.pending,
      },
    }),
  ]);

  const successRate = total > 0 ? (delivered / total) * 100 : 0;

  return {
    total,
    delivered,
    failed,
    pending,
    successRate: Math.round(successRate * 100) / 100,
    period_days: days,
  };
}

/**
 * Clean up old webhook deliveries
 */
export async function cleanupOldWebhookDeliveries(
  daysToKeep = 30,
): Promise<number> {
  const threshold = new Date(Date.now() - daysToKeep * 24 * 60 * 60 * 1000);

  const result = await prisma.a2aWebhookDelivery.deleteMany({
    where: {
      createdAt: { lt: threshold },
      status: {
        in: [A2aWebhookStatus.delivered, A2aWebhookStatus.failed],
      },
    },
  });

  return result.count;
}
