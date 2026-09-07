import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { A2aTaskState } from "@/generated/prisma/enums";
import { getTool } from "@/utils/mcp-server/tools/registry";
import type { McpToolContext } from "@/utils/mcp-server/tools/registry";
import {
  getSkillDefinition,
  pendingApprovalsSummary,
} from "./protocol-handler";
import { publishApprovals } from "@/utils/mqtt/events";

const logger = createScopedLogger("a2a-task-executor");

/**
 * Task Executor
 *
 * Executes A2A tasks by mapping them to MCP tools and managing state transitions.
 * Implements the A2A task state machine with immutable terminal states.
 */

/**
 * Execute a task by ID
 *
 * This is the main entry point for task execution.
 * It loads the task, validates it can be executed, runs the MCP tool,
 * and updates the task state based on the result.
 *
 * @param taskId - The internal task ID (not taskId - the public identifier)
 */
export async function executeTask(taskId: string): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
  });

  if (!task) {
    logger.error("Task not found", { taskId });
    throw new Error(`Task not found: ${taskId}`);
  }

  // Check if task can be executed
  if (!canExecuteTask(task.state)) {
    logger.warn("Task cannot be executed in current state", {
      taskId: task.taskId,
      state: task.state,
    });
    return;
  }

  const startTime = Date.now();

  try {
    // Transition to working state
    await transitionTaskState(
      task.id,
      task.state,
      A2aTaskState.working,
      "Executing task",
    );

    // Get skill definition
    const skillDef = getSkillDefinition(task.skill);
    if (!skillDef) {
      throw new Error(`Unknown skill: ${task.skill}`);
    }

    // Get MCP tool
    const tool = getTool(skillDef.mcpTool);
    if (!tool) {
      throw new Error(`MCP tool not found: ${skillDef.mcpTool}`);
    }

    // Prepare MCP tool context
    const mcpContext: McpToolContext = {
      userId: task.userId,
      emailAccountId: task.emailAccountId || "",
      clientId: task.clientId || "",
      scopes: [skillDef.requiredScope],
    };

    // Execute the MCP tool
    logger.info("Executing MCP tool for A2A task", {
      taskId: task.taskId,
      skill: task.skill,
      mcpTool: skillDef.mcpTool,
    });

    const result = await tool.handler(mcpContext, task.input);

    // Calculate execution time
    const durationMs = Date.now() - startTime;

    // Transition to completed state
    await transitionTaskState(
      task.id,
      A2aTaskState.working,
      A2aTaskState.completed,
      "Task completed successfully",
      // MCP handlers return `unknown`; the column is Json either way.
      { result: result as Prisma.InputJsonValue, durationMs },
    );

    logger.info("Task completed successfully", {
      taskId: task.taskId,
      skill: task.skill,
      durationMs,
    });
  } catch (error) {
    const durationMs = Date.now() - startTime;

    const { message: errorMessage, stack: errorStack } = toErrorParts(error);

    logger.error("Task execution failed", {
      taskId: task.taskId,
      skill: task.skill,
      error: errorMessage,
      durationMs,
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
    });

    // Check if we should retry
    const shouldRetry =
      task.retryCount < task.maxRetries && isRetriableError(error);

    if (shouldRetry) {
      // Increment retry count and transition back to submitted
      await prisma.a2aTask.update({
        where: { id: task.id },
        data: {
          state: A2aTaskState.submitted,
          stateReason: `Retrying after error (attempt ${task.retryCount + 1}/${task.maxRetries})`,
          retryCount: task.retryCount + 1,
          lastRetryAt: new Date(),
          error: {
            message: errorMessage,
            stack: errorStack,
            retryable: true,
          },
        },
      });

      // Record retry state transition
      await prisma.a2aTaskHistory.create({
        data: {
          taskId: task.id,
          fromState: A2aTaskState.working,
          toState: A2aTaskState.submitted,
          reason: `Retrying after error (attempt ${task.retryCount + 1}/${task.maxRetries}): ${errorMessage}`,
          durationMs,
        },
      });

      logger.info("Task queued for retry", {
        taskId: task.taskId,
        retryCount: task.retryCount + 1,
        maxRetries: task.maxRetries,
      });
    } else {
      // Max retries exceeded or non-retriable error - mark as failed
      await transitionTaskState(
        task.id,
        A2aTaskState.working,
        A2aTaskState.failed,
        shouldRetry
          ? `Execution failed: ${errorMessage}`
          : `Max retries exceeded (${task.maxRetries}): ${errorMessage}`,
        {
          error: {
            message: errorMessage,
            stack: errorStack,
            retryable: isRetriableError(error),
            retriesExhausted: task.retryCount >= task.maxRetries,
          },
          durationMs,
        },
      );
    }
  }
}

/**
 * Transition a task from one state to another
 *
 * Enforces the A2A state machine rules:
 * - Terminal states (completed, failed, canceled, rejected, unknown) are immutable
 * - Validates allowed state transitions
 * - Records state history
 * - Updates task with result/error data
 */
async function transitionTaskState(
  taskId: string,
  fromState: A2aTaskState,
  toState: A2aTaskState,
  reason: string,
  data?: {
    result?: Prisma.InputJsonValue;
    error?: Prisma.InputJsonValue;
    artifacts?: Prisma.InputJsonValue;
    durationMs?: number;
  },
): Promise<void> {
  const terminalStates: A2aTaskState[] = [
    A2aTaskState.completed,
    A2aTaskState.failed,
    A2aTaskState.canceled,
    A2aTaskState.rejected,
    A2aTaskState.unknown,
  ];

  // Validate state transition
  if (terminalStates.includes(fromState)) {
    throw new Error(`Cannot transition from terminal state: ${fromState}`);
  }

  const isTerminalState = terminalStates.includes(toState);

  // Update task
  await prisma.a2aTask.update({
    where: { id: taskId },
    data: {
      state: toState,
      stateReason: reason,
      ...(data?.result && { result: data.result }),
      ...(data?.error && { error: data.error }),
      ...(data?.artifacts && { artifacts: data.artifacts }),
      ...(isTerminalState && { completedAt: new Date() }),
    },
  });

  // Record state transition in history
  await prisma.a2aTaskHistory.create({
    data: {
      taskId,
      fromState,
      toState,
      reason,
      durationMs: data?.durationMs,
      metadata: data
        ? {
            hasResult: !!data.result,
            hasError: !!data.error,
            hasArtifacts: !!data.artifacts,
          }
        : undefined,
    },
  });

  logger.info("Task state transition", {
    taskId,
    fromState,
    toState,
    reason,
    isTerminal: isTerminalState,
  });

  // Queue webhooks for state change (async, don't block)
  import("./webhooks")
    .then(({ queueWebhooksForStateChange }) =>
      queueWebhooksForStateChange(taskId, fromState, toState),
    )
    .catch((error) => {
      logger.error("Failed to queue webhooks for state change", {
        taskId,
        fromState,
        toState,
        error: error.message,
      });
    });
}

/**
 * Check if a task can be executed in its current state
 */
function canExecuteTask(state: A2aTaskState): boolean {
  // Tasks can only be executed from submitted state
  // (auth_required tasks must be approved first, which transitions them to submitted)
  return state === A2aTaskState.submitted;
}

/**
 * Process all pending tasks
 *
 * This function should be called periodically (e.g., via cron job)
 * to process tasks that are in the submitted state.
 *
 * @param limit - Maximum number of tasks to process in this batch
 */
export async function processPendingTasks(limit = 10): Promise<void> {
  const pendingTasks = await prisma.a2aTask.findMany({
    where: {
      state: A2aTaskState.submitted,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true, taskId: true, skill: true },
  });

  logger.info("Processing pending A2A tasks", {
    count: pendingTasks.length,
    limit,
  });

  for (const task of pendingTasks) {
    try {
      await executeTask(task.id);
    } catch (error) {
      logger.error("Failed to execute pending task", {
        taskId: task.taskId,
        skill: task.skill,
        error,
      });
    }
  }
}

/**
 * Handle task approval
 *
 * Called when a human approves a task in auth_required state.
 * Transitions the task to submitted state so it can be executed.
 */
export async function approveTask(
  taskId: string,
  approverId: string,
  responseData?: Prisma.InputJsonValue,
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.state !== A2aTaskState.auth_required) {
    throw new Error(`Task is not in auth_required state: ${task.state}`);
  }

  // Update approval record
  await prisma.a2aApproval.update({
    where: { taskId },
    data: {
      status: "approved",
      approved: true,
      approverId,
      responseData,
      respondedAt: new Date(),
    },
  });

  // Approving is one of the ways an approval leaves the pending queue, so the
  // bus's count has to drop here too — not just on creation and withdrawal.
  // Task rows predate the emailAccountId column and may not carry one; there
  // is nothing to report to the bus for those. The catch is load-bearing,
  // same as the two existing publish sites: a database blip must not fail an
  // approval.
  const { emailAccountId } = task;
  if (emailAccountId) {
    await pendingApprovalsSummary(emailAccountId)
      .then((approvalsSummary) =>
        publishApprovals({ emailAccountId, ...approvalsSummary }),
      )
      .catch(() => {});
  }

  // Transition task to submitted state for execution
  await transitionTaskState(
    task.id,
    A2aTaskState.auth_required,
    A2aTaskState.submitted,
    "Approved by human",
  );

  // Execute the task
  await executeTask(task.id);

  logger.info("Task approved and queued for execution", {
    taskId: task.taskId,
    approverId,
  });
}

/**
 * Handle task rejection
 *
 * Called when a human rejects a task in auth_required state.
 * Transitions the task to rejected terminal state.
 */
export async function rejectTask(
  taskId: string,
  approverId: string,
  rejectionReason: string,
): Promise<void> {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskId },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  if (task.state !== A2aTaskState.auth_required) {
    throw new Error(`Task is not in auth_required state: ${task.state}`);
  }

  // Update approval record
  await prisma.a2aApproval.update({
    where: { taskId },
    data: {
      status: "rejected",
      approved: false,
      approverId,
      rejectionReason,
      respondedAt: new Date(),
    },
  });

  // Rejecting also removes this approval from the pending queue. Same
  // load-bearing catch and missing-emailAccountId guard as approveTask above.
  const { emailAccountId } = task;
  if (emailAccountId) {
    await pendingApprovalsSummary(emailAccountId)
      .then((approvalsSummary) =>
        publishApprovals({ emailAccountId, ...approvalsSummary }),
      )
      .catch(() => {});
  }

  // Transition task to rejected terminal state
  await transitionTaskState(
    task.id,
    A2aTaskState.auth_required,
    A2aTaskState.rejected,
    `Rejected by human: ${rejectionReason}`,
  );

  logger.info("Task rejected", {
    taskId: task.taskId,
    approverId,
    reason: rejectionReason,
  });
}

/**
 * Get tasks requiring approval for a user
 */
export async function getTasksRequiringApproval(userId: string) {
  return prisma.a2aTask.findMany({
    where: {
      userId,
      state: A2aTaskState.auth_required,
    },
    include: {
      user: {
        select: {
          email: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Determine if an error is retriable
 *
 * Retriable errors are typically transient issues that may succeed on retry:
 * - Network errors
 * - Timeouts
 * - Rate limits (429)
 * - Service unavailable (503)
 * - Gateway errors (502, 504)
 *
 * Non-retriable errors are typically permanent:
 * - Bad request (400)
 * - Unauthorized (401)
 * - Forbidden (403)
 * - Not found (404)
 * - Validation errors
 */
function isRetriableError(error: unknown): boolean {
  const { code, message } = toErrorShape(error);

  // Network/connection errors
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  // HTTP status codes
  const { status } = toErrorShape(error);
  if (status) {
    // Rate limits, service unavailable, gateway errors
    if (status === 429 || status === 503 || status === 502 || status === 504) {
      return true;
    }
    // Client errors (except rate limit) are not retriable
    if (status >= 400 && status < 500) {
      return false;
    }
    // Server errors (5xx) are generally retriable
    if (status >= 500) {
      return true;
    }
  }

  // Error messages indicating transient issues
  const errorMessage = message.toLowerCase();
  if (
    errorMessage.includes("timeout") ||
    errorMessage.includes("connection") ||
    errorMessage.includes("network") ||
    errorMessage.includes("temporarily unavailable")
  ) {
    return true;
  }

  // Default to non-retriable for unknown errors
  return false;
}

/** Pull a message and stack off an unknown throw value. */
function toErrorParts(error: unknown) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }

  return { message: String(error), stack: undefined };
}

/** Node/system errors carry a `code`; plain Errors only a message. */
function toErrorShape(error: unknown) {
  if (error && typeof error === "object") {
    const candidate = error as {
      code?: unknown;
      message?: unknown;
      status?: unknown;
      statusCode?: unknown;
    };

    const status =
      typeof candidate.status === "number"
        ? candidate.status
        : typeof candidate.statusCode === "number"
          ? candidate.statusCode
          : undefined;

    return {
      code: typeof candidate.code === "string" ? candidate.code : undefined,
      message: typeof candidate.message === "string" ? candidate.message : "",
      status,
    };
  }

  return { code: undefined, message: String(error), status: undefined };
}
