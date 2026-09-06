import "server-only";
import { createScopedLogger } from "@/utils/logger";
import { dharahilClient } from "@/utils/dharahil/client";
import type { DharaHILDecision } from "@/utils/dharahil/client";
import prisma from "@/utils/prisma";
import { A2aTaskState } from "@/generated/prisma/enums";
import { approveTask, rejectTask } from "./task-executor";
import { env } from "@/env";

const logger = createScopedLogger("a2a-dharahil");

/**
 * A2A DharaHIL Integration
 *
 * Integrates the A2A approval workflow with DharaHIL for human-in-the-loop
 * approval via Slack/Telegram notifications.
 *
 * Flow:
 * 1. Task requires approval → Creates A2aApproval record
 * 2. Submits request to DharaHIL gateway
 * 3. DharaHIL sends notification to Slack/Telegram
 * 4. Human responds (APPROVE/REJECT/REVISE)
 * 5. Updates A2aApproval and task state accordingly
 */

/**
 * Request approval for a task via DharaHIL
 *
 * Called when a task enters auth_required state.
 * Submits the approval request to DharaHIL and stores the request ID.
 *
 * @param taskInternalId - The internal database ID of the A2aTask
 * @returns DharaHIL request ID for polling
 */
export async function requestApprovalViaDharaHIL(
  taskInternalId: string,
): Promise<string> {
  // Check if DharaHIL is enabled
  if (!env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.info("DharaHIL disabled, skipping approval request", {
      taskInternalId,
    });
    throw new Error("DharaHIL is disabled - manual approval required via UI");
  }

  const task = await prisma.a2aTask.findUnique({
    where: { id: taskInternalId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
        },
      },
    },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskInternalId}`);
  }

  if (task.state !== A2aTaskState.auth_required) {
    throw new Error(`Task is not in auth_required state: ${task.state}`);
  }

  // Determine risk level based on skill
  const riskLevel = determineRiskLevel(task.skill, task.input);

  // Create context summary
  const contextSummary = createContextSummary(
    task.skill,
    task.input,
    task.user.email || "unknown",
  );

  // Prepare DharaHIL request
  const request = {
    toolName: task.skill,
    toolArgs: toToolArgs(task.input),
    context: {
      agentId: "inbox-a2a-agent",
      runId: task.userId,
      stepId: task.taskId,
      contextSummary,
      riskLevel,
      tags: ["a2a", "agent-protocol", task.skill.split(".")[0]], // e.g., ["a2a", "agent-protocol", "calendar"]
      idempotencyKey: `a2a_task_${task.taskId}`,
      metadata: {
        task_id: task.taskId,
        context_id: task.contextId,
        client_id: task.clientId || "unknown",
        user_email: task.user.email || "unknown",
        skill: task.skill,
      },
    },
  };

  logger.info("Submitting A2A task for DharaHIL approval", {
    taskId: task.taskId,
    skill: task.skill,
    riskLevel,
  });

  try {
    // Submit to DharaHIL gateway
    const response = await dharahilClient.beforeExecute(request);

    // Update approval record with DharaHIL request ID
    await prisma.a2aApproval.update({
      where: { taskId: task.id },
      data: {
        dharahilRequestId: response.request_id,
        expiresAt: new Date(response.expires_at),
      },
    });

    logger.info("DharaHIL approval request submitted successfully", {
      taskId: task.taskId,
      requestId: response.request_id,
      expiresAt: response.expires_at,
    });

    return response.request_id;
  } catch (error) {
    logger.error("Failed to submit DharaHIL approval request", {
      taskId: task.taskId,
      error,
    });

    // Update approval with error
    await prisma.a2aApproval.update({
      where: { taskId: task.id },
      data: {
        status: "rejected",
        approved: false,
        rejectionReason: `DharaHIL submission failed: ${error instanceof Error ? error.message : String(error)}`,
        respondedAt: new Date(),
      },
    });

    throw error;
  }
}

/**
 * Poll for DharaHIL decision and update task accordingly
 *
 * This should be called periodically (e.g., from a background job)
 * to check if a decision has been made on pending approvals.
 *
 * @param taskInternalId - The internal database ID of the A2aTask
 * @returns Decision from DharaHIL
 */
export async function pollForApprovalDecision(
  taskInternalId: string,
): Promise<DharaHILDecision> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskInternalId },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskInternalId}`);
  }

  const approval = await prisma.a2aApproval.findUnique({
    where: { taskId: taskInternalId },
  });

  if (!approval?.dharahilRequestId) {
    throw new Error(`No DharaHIL request found for task: ${task.taskId}`);
  }

  const requestId = approval.dharahilRequestId;
  const expiresAt = approval.expiresAt?.toISOString();

  if (!expiresAt) {
    throw new Error(`No expiry time found for DharaHIL request: ${requestId}`);
  }

  logger.info("Polling for DharaHIL decision", {
    taskId: task.taskId,
    requestId,
    expiresAt,
  });

  // Poll for decision
  const decision = await dharahilClient.pollForDecision(requestId, expiresAt);

  // Handle decision
  await handleDharaHILDecision(taskInternalId, decision);

  return decision;
}

/**
 * Handle DharaHIL decision by updating task state
 */
async function handleDharaHILDecision(
  taskInternalId: string,
  decision: DharaHILDecision,
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskInternalId },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskInternalId}`);
  }

  logger.info("Handling DharaHIL decision for A2A task", {
    taskId: task.taskId,
    decision: decision.action,
    reason: decision.reason,
  });

  if (dharahilClient.shouldProceed(decision)) {
    // APPROVED - Execute the task
    logger.info("Task approved via DharaHIL", { taskId: task.taskId });

    await approveTask(taskInternalId, "dharahil_gateway", {
      action: decision.action,
      reason: decision.reason,
      approved_via: "dharahil",
    });
  } else if (dharahilClient.shouldRevise(decision)) {
    // REVISE_REQUESTED - Store revision instructions
    logger.info("Task revision requested via DharaHIL", {
      taskId: task.taskId,
      instructions: decision.revise_input,
    });

    await prisma.a2aApproval.update({
      where: { taskId: taskInternalId },
      data: {
        status: "pending",
        revisionRequested: true,
        revisionInstructions: decision.revise_input,
        responseData: {
          action: decision.action,
          reason: decision.reason,
          revise_input: decision.revise_input,
        },
        respondedAt: new Date(),
      },
    });

    // Note: A2A protocol doesn't have a "revise" state, so we keep it in auth_required
    // The client needs to create a new task with revised parameters
  } else if (dharahilClient.wasDenied(decision)) {
    // REJECTED / EXPIRED / ERROR - Reject the task
    logger.warn("Task denied via DharaHIL", {
      taskId: task.taskId,
      action: decision.action,
      reason: decision.reason,
    });

    const rejectionReason =
      decision.action === "EXPIRED"
        ? "Approval request expired - human did not respond in time"
        : `Rejected by human: ${decision.reason || "No reason provided"}`;

    await rejectTask(taskInternalId, "dharahil_gateway", rejectionReason);
  }
}

/**
 * Process all pending DharaHIL approvals
 *
 * Should be called periodically (e.g., every 5 seconds from a background job)
 * to check for decisions on pending approvals.
 */
export async function processPendingDharaHILApprovals(): Promise<void> {
  if (!env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.trace("DharaHIL disabled, skipping approval processing");
    return;
  }

  const pendingApprovals = await prisma.a2aApproval.findMany({
    where: {
      status: "pending",
      dharahilRequestId: {
        not: null,
      },
      expiresAt: {
        gte: new Date(), // Only check non-expired approvals
      },
    },
    orderBy: { requestedAt: "asc" },
    take: 20, // Process up to 20 approvals at a time
  });

  if (pendingApprovals.length === 0) {
    logger.trace("No pending DharaHIL approvals to process");
    return;
  }

  logger.info("Processing pending DharaHIL approvals", {
    count: pendingApprovals.length,
  });

  for (const approval of pendingApprovals) {
    try {
      // One shot, not the full TTL wait: this runs on a schedule.
      const requestId = approval.dharahilRequestId!;
      const decision = await dharahilClient.fetchDecision(requestId);

      if (decision) {
        logger.info("DharaHIL decision received", {
          taskId: approval.taskId,
          requestId,
          decision: decision.action,
        });

        await handleDharaHILDecision(approval.taskId, decision);
      }
    } catch (error) {
      logger.error("Error processing DharaHIL approval", {
        approvalId: approval.id,
        taskId: approval.taskId,
        error,
      });
    }
  }
}

/**
 * Handle expired DharaHIL approvals
 *
 * Mark approvals as rejected if they expire without a decision.
 */
export async function processExpiredDharaHILApprovals(): Promise<void> {
  const expiredApprovals = await prisma.a2aApproval.findMany({
    where: {
      status: "pending",
      dharahilRequestId: {
        not: null,
      },
      expiresAt: {
        lt: new Date(), // Expired
      },
    },
  });

  if (expiredApprovals.length === 0) {
    return;
  }

  logger.warn("Processing expired DharaHIL approvals", {
    count: expiredApprovals.length,
  });

  for (const approval of expiredApprovals) {
    try {
      await rejectTask(
        approval.taskId,
        "dharahil_gateway",
        "Approval request expired - human did not respond in time",
      );

      logger.info("Marked expired approval as rejected", {
        taskId: approval.taskId,
        requestId: approval.dharahilRequestId,
      });
    } catch (error) {
      logger.error("Failed to reject expired approval", {
        approvalId: approval.id,
        taskId: approval.taskId,
        error,
      });
    }
  }
}

/**
 * Determine risk level for a skill
 *
 * Risk levels determine TTL and urgency in DharaHIL:
 * - CRITICAL: 3 minutes (external actions, high impact)
 * - HIGH: 5 minutes (external attendees, calendar events)
 * - MEDIUM: 15 minutes (internal actions)
 * - LOW: 30 minutes (read-only or low impact)
 */
function determineRiskLevel(
  skill: string,
  input: any,
): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  // Calendar event creation with external attendees
  if (skill === "calendar.create_event") {
    const hasExternal =
      input.attendees?.some((email: string) => isExternalDomain(email)) ||
      false;
    return hasExternal ? "HIGH" : "MEDIUM";
  }

  // Email sending
  if (skill === "email.send") {
    const hasExternal = isExternalDomain(input.to?.[0] || "");
    return hasExternal ? "CRITICAL" : "HIGH";
  }

  // Other write operations
  if (
    skill.includes("create") ||
    skill.includes("send") ||
    skill.includes("update")
  ) {
    return "MEDIUM";
  }

  // Read-only operations
  return "LOW";
}

/**
 * Check if an email belongs to an external domain
 */
function isExternalDomain(email: string): boolean {
  if (!email || typeof email !== "string") return false;

  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return false;

  // List of internal domains (customize as needed)
  const internalDomains = [
    "sudiptadhara.in",
    "inboxzero.com",
    "getinboxzero.com",
    "localhost",
  ];

  return !internalDomains.some((internal) => domain.endsWith(internal));
}

/**
 * Create human-readable context summary
 */
function createContextSummary(
  skill: string,
  input: any,
  userEmail: string,
): string {
  switch (skill) {
    case "calendar.create_event": {
      const attendeeCount = input.attendees?.length || 0;
      const hasExternal =
        input.attendees?.some((email: string) => isExternalDomain(email)) ||
        false;
      return `Create calendar event: "${input.title}" with ${attendeeCount} attendee(s) ${hasExternal ? "(EXTERNAL)" : "(internal)"} - Requested by ${userEmail}`;
    }

    case "email.send": {
      const toExternal = isExternalDomain(input.to?.[0] || "");
      return `Send email to ${input.to?.join(", ")} ${toExternal ? "(EXTERNAL)" : "(internal)"} - Subject: "${input.subject}" - Requested by ${userEmail}`;
    }

    case "calendar.search":
      return `Search calendar events from ${input.startDate} to ${input.endDate} - Requested by ${userEmail}`;

    case "email.search":
      return `Search emails: "${input.query}" (max ${input.maxResults || 10} results) - Requested by ${userEmail}`;

    default:
      return `Execute skill "${skill}" - Requested by ${userEmail}`;
  }
}

/**
 * A2aTask.input is a Json column, so it can be a scalar, an array or null even
 * though skills always write an object. Keep the reviewer-facing payload an
 * object rather than letting a stray scalar through untyped.
 */
function toToolArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  return { value: input };
}
