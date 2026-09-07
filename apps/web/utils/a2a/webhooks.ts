import "server-only";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { A2aTaskState, A2aWebhookStatus } from "@/generated/prisma/enums";
import { toWireState } from "@/utils/a2a/wire-state";
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

  const webhookConfig = await getConfigForTask(task.clientId, task.taskId);

  if (!webhookConfig) {
    logger.trace("No webhook configured for client", {
      clientId: task.clientId,
      event,
    });
    return;
  }

  // A disabled client default is a client-wide kill switch, not just a
  // fallback for tasks with no row of their own: without this check, a peer
  // disabled by the owner could resume delivery by calling `set` with a
  // taskId, since the fresh task-specific row is created enabled and always
  // wins the lookup above over the disabled default. Folded into one helper
  // so `pushconfig.get/list/set` (see push-config.ts's toResponse) and
  // deliverWebhook's retry path can't drift from what actually ships here.
  if (!(await isConfigEffectivelyEnabled(webhookConfig))) {
    logger.trace(
      "Webhook config disabled or suppressed by a disabled client default",
      { clientId: task.clientId, event },
    );
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
      state: toWireState(task.state),
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
    // A2A §3.1.7's token: echoed back so the peer can verify this call came
    // from us. Looked up fresh rather than snapshotted at queue time, so a
    // token rotated after this delivery was queued still gets used. `taskId`
    // here is the internal a2aTask row id (queueWebhook's own doing); the
    // config lookup keys on the task's public taskId instead.
    const task = await prisma.a2aTask.findUnique({
      where: { id: delivery.taskId },
      select: { taskId: true },
    });
    const webhookConfig = task
      ? await getConfigForTask(delivery.clientId, task.taskId)
      : null;

    // The config may have been disabled (or the task-specific row deleted
    // outright, e.g. by DELETE /api/user/a2a-webhooks) after this delivery
    // was queued but before a retry runs. Without this, a delivery queued
    // while push was on keeps firing through all five retries regardless of
    // what the peer does in between.
    if (!webhookConfig || !(await isConfigEffectivelyEnabled(webhookConfig))) {
      logger.info("Skipping webhook delivery: config disabled or removed", {
        deliveryId,
        taskId: delivery.taskId,
        event: delivery.event,
      });

      await prisma.a2aWebhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: A2aWebhookStatus.failed,
          lastAttemptAt: new Date(),
          errorMessage: "Push notification config disabled or removed",
          nextAttemptAt: null,
        },
      });

      return false;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "InboxZero-A2A-Webhook/1.0",
      "X-Webhook-Signature": delivery.signature || "",
      "X-Webhook-Event": delivery.event,
      "X-Webhook-Delivery-ID": delivery.id,
    };

    if (webhookConfig.token) {
      headers["X-A2A-Notification-Token"] = webhookConfig.token;
    }

    // Make HTTP request
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10_000); // 10 second timeout

    const response = await fetch(delivery.url, {
      method: delivery.method,
      headers,
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

// A2A §3.1.7 config is per task; a NULL taskId row is the client's default.
// `IN (taskId, NULL)` would silently drop the NULL row — SQL's IN never
// matches NULL — so the fallback is an explicit OR. Postgres also defaults
// DESC to NULLS FIRST, which would hand back the default even when a
// task-specific row exists, hence the explicit NULLS LAST. This exact shape
// has been duplicated (and gotten wrong) more than once, so it's defined
// here once and shared by every findFirst/findMany that needs "this task's
// own config, or the client default" (see getConfigForTask below and
// handlePushConfigList in push-config.ts).
export function taskConfigWhere(clientId: string, taskId: string) {
  return {
    clientId,
    OR: [{ taskId }, { taskId: null }],
  };
}

export const TASK_CONFIG_ORDER = {
  taskId: { sort: "desc", nulls: "last" },
} as const;

/**
 * Find the push notification config that applies to a task: its own
 * task-specific row if one exists, else the client's default.
 */
export function getConfigForTask(clientId: string, taskId: string) {
  return prisma.a2aWebhookConfig.findFirst({
    where: taskConfigWhere(clientId, taskId),
    orderBy: TASK_CONFIG_ORDER,
  });
}

/**
 * Whether a config would actually let a delivery through: its own `enabled`
 * flag, folded with the client-wide kill switch a disabled default enforces
 * over every task-specific row (see queueWebhook). Shared with
 * push-config.ts's toResponse so a peer is never told `enabled: true` while
 * queueWebhook and deliverWebhook are suppressing every delivery.
 */
export async function isConfigEffectivelyEnabled(config: {
  clientId: string;
  taskId: string | null;
  enabled: boolean;
}): Promise<boolean> {
  if (!config.enabled) return false;
  if (config.taskId === null) return true;

  const clientDefault = await prisma.a2aWebhookConfig.findFirst({
    where: { clientId: config.clientId, taskId: null },
    select: { enabled: true },
  });

  return !clientDefault || clientDefault.enabled;
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
