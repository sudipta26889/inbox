import { createScopedLogger } from "@/utils/logger";
import type { Prisma } from "@/generated/prisma/client";
import { isPeerReachableSkill } from "@/utils/a2a/peer-tool-policy";
import { answerA2aMessage, extractQuestion } from "@/utils/a2a/answer-message";
import prisma from "@/utils/prisma";
import {
  A2A_SKILL_REGISTRY,
  type A2aSkillDefinition,
} from "@/utils/a2a/skill-registry";
import type { A2aAuthContext } from "./auth";
import { validateSkillAccess } from "./auth";
import { A2aApprovalStatus, A2aTaskState } from "@/generated/prisma/enums";
import { canonicalActionKey } from "@/utils/dharahil/prior-decision";
import { taskScope } from "@/utils/a2a/task-scope";
import { checkA2aRequestRateLimit } from "@/utils/a2a/rate-limit";
import { nanoid } from "nanoid";

const logger = createScopedLogger("a2a-protocol");

/**
 * A2A Protocol v0.3 Handler
 *
 * Implements the core A2A protocol methods:
 * - message.send: Create tasks and send messages
 * - task.get: Get task status
 * - task.list: List tasks in a context
 * - task.cancel: Cancel a running task
 * - context.get: Get all messages in a context
 */

/**
 * A2A Skill Definition
 * Maps A2A skill names to MCP tool names and required scopes
 */

/**
 * Message.send request parameters
 */
export interface MessageSendParams {
  content?: string | unknown[];
  contextId: string;
  input?: Record<string, unknown>;
  referenceTaskIds?: string[];
  skill?: string;
}

/**
 * Message.send response
 */
export interface MessageSendResponse {
  answer?: string;
  contextId: string;
  messageId?: string;
  replyMessageId?: string;
  state?: A2aTaskState;
  taskId?: string;
}

/**
 * Task.get request parameters
 */
export interface TaskGetParams {
  taskId: string;
}

/**
 * Task.list request parameters
 */
export interface TaskListParams {
  contextId: string;
  limit?: number;
  state?: A2aTaskState;
}

/**
 * Task.cancel request parameters
 */
export interface TaskCancelParams {
  reason?: string;
  taskId: string;
}

/**
 * Context.get request parameters
 */
export interface ContextGetParams {
  contextId: string;
  limit?: number;
}

/**
 * Handle message.send - Create a new task
 */
export async function handleMessageSend(
  authContext: A2aAuthContext,
  params: MessageSendParams,
): Promise<MessageSendResponse> {
  const { contextId, skill, input, content, referenceTaskIds = [] } = params;

  // Validate parameters
  if (!contextId) {
    throw new Error("contextId is required");
  }

  // If no skill provided, this is just a message (no task created)
  if (!skill) {
    const messageId = nanoid();

    await prisma.a2aMessage.create({
      data: {
        id: messageId,
        contextId,
        role: "user",
        content: (content ?? {}) as Prisma.InputJsonValue,
        contentType: typeof content === "string" ? "text" : "structured_data",
        referenceTaskIds,
      },
    });

    logger.info("Created A2A message", { contextId, messageId });

    // A peer that sent text asked a question. Answer it rather than returning
    // a bare messageId, which is what made every plain-text message a silent
    // no-op behind an HTTP 200.
    const question = extractQuestion(content);

    if (question) {
      try {
        const answer = await answerA2aMessage({
          emailAccountId: authContext.emailAccountId,
          question,
          contextId,
          logger,
        });

        if (answer) {
          const replyId = nanoid();
          await prisma.a2aMessage.create({
            data: {
              id: replyId,
              contextId,
              role: "agent",
              content: answer as Prisma.InputJsonValue,
              contentType: "text",
              referenceTaskIds: [],
            },
          });

          return { contextId, messageId, replyMessageId: replyId, answer };
        }
      } catch (error) {
        // A failed answer must not lose the peer's message, which is already
        // stored above.
        logger.error("Failed to answer A2A message", { contextId, error });
      }
    }

    return {
      contextId,
      messageId,
    };
  }

  // Validate skill exists
  const skillDef = A2A_SKILL_REGISTRY[skill];
  if (!skillDef) {
    throw new Error(`Unknown skill: ${skill}`);
  }

  // Deny writes at the point skills are dispatched, not per-skill. A peer
  // holding a write scope is still not the account owner.
  if (!isPeerReachableSkill(skill)) {
    logger.warn("Peer attempted a skill that is not peer-reachable", {
      skill,
      clientId: authContext.clientId,
    });
    throw new Error(
      `Skill '${skill}' is not available to external agents. Writes are performed by the account owner.`,
    );
  }

  // Check authorization
  const authError = await validateSkillAccess(
    authContext,
    skill,
    skillDef.requiredScope,
  );

  if (authError) {
    throw new Error(authError.body.detail);
  }

  // Create task
  const taskId = nanoid();
  const requiresApproval = skillDef.requiresApproval || false;

  // Checked before anything is written. A skill that parks for approval spends
  // a human's attention, not just CPU, and the task-creation limits are far too
  // loose for that — they would let a peer raise hundreds of prompts an hour
  // until one gets waved through unread.
  if (requiresApproval) {
    const approvalBudget = await checkA2aRequestRateLimit(
      authContext,
      "approval_request",
    );

    if (!approvalBudget.allowed) {
      logger.warn("Refusing to raise another approval request", {
        clientId: authContext.clientId,
        skill,
        limit: approvalBudget.limit,
      });
      throw new Error(
        `Too many approval requests. This peer may raise ${approvalBudget.limit} approvals per window; try again after ${approvalBudget.resetAt.toISOString()}.`,
      );
    }
  }

  const initialState = requiresApproval
    ? A2aTaskState.auth_required
    : A2aTaskState.submitted;

  const task = await prisma.a2aTask.create({
    data: {
      taskId,
      userId: authContext.userId,
      emailAccountId: authContext.emailAccountId,
      clientId: authContext.clientId,
      contextId,
      skill,
      input: (input ?? {}) as Prisma.InputJsonValue,
      state: initialState,
      requiresApproval,
      referenceTaskIds,
    },
  });

  // Record state transition
  await prisma.a2aTaskHistory.create({
    data: {
      taskId: task.id,
      fromState: A2aTaskState.submitted,
      toState: initialState,
      reason: requiresApproval
        ? "Skill requires human approval"
        : "Task created",
    },
  });

  // If requires approval, create approval request
  if (requiresApproval) {
    await prisma.a2aApproval.create({
      data: {
        taskId: task.id,
        skill,
        requestData: (input ?? {}) as Prisma.InputJsonValue,
        requestReason: `External agent "${authContext.clientId}" requesting approval for ${skill}`,
        status: A2aApprovalStatus.pending,
        // Keyed on the MCP tool name and the same arguments the tool will
        // receive, so the tool can recognise this decision when it runs and
        // does not ask the human a second time for the same event.
        actionKey: canonicalActionKey({
          userId: authContext.userId,
          emailAccountId: authContext.emailAccountId,
          operation: skillDef.mcpTool,
          args: input ?? {},
        }),
      },
    });

    logger.info("Created A2A task requiring approval", {
      taskId,
      skill,
      contextId,
    });

    // Submit to DharaHIL for human approval
    try {
      const { requestApprovalViaDharaHIL } = await import(
        "./dharahil-integration"
      );

      // Submit asynchronously (don't block task creation)
      requestApprovalViaDharaHIL(task.id).catch((error) => {
        logger.error("Failed to submit DharaHIL approval request", {
          taskId,
          error: error.message,
        });
      });
    } catch (error) {
      logger.error("DharaHIL integration error", {
        taskId,
        error,
      });
    }
  } else {
    // Execute task immediately
    logger.info("Created A2A task, executing immediately", {
      taskId,
      skill,
      contextId,
    });

    // Import dynamically to avoid circular dependencies
    const { executeTask } = await import("./task-executor");

    // Execute task asynchronously (don't await - return task immediately)
    executeTask(task.id).catch((error) => {
      logger.error("Failed to execute task", {
        taskId,
        error: error.message,
      });
    });
  }

  return {
    contextId,
    taskId,
    state: initialState,
  };
}

/**
 * Handle task.get - Get task details
 */
export async function handleTaskGet(
  authContext: A2aAuthContext,
  params: TaskGetParams,
) {
  const { taskId } = params;

  if (!taskId) {
    throw new Error("taskId is required");
  }

  const task = await prisma.a2aTask.findUnique({
    where: {
      taskId,
      ...taskScope(authContext),
    },
    include: {
      history: {
        orderBy: { timestamp: "asc" },
        take: 100,
      },
    },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Build response following A2A spec
  return {
    taskId: task.taskId,
    contextId: task.contextId,
    skill: task.skill,
    state: task.state,
    stateReason: task.stateReason,
    input: task.input,
    result: task.result,
    error: task.error,
    artifacts: task.artifacts,
    referenceTaskIds: task.referenceTaskIds,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    completedAt: task.completedAt?.toISOString(),
    history: task.history.map((h) => ({
      fromState: h.fromState,
      toState: h.toState,
      reason: h.reason,
      timestamp: h.timestamp.toISOString(),
      durationMs: h.durationMs,
    })),
  };
}

/**
 * Handle task.list - List tasks in a context
 */
export async function handleTaskList(
  authContext: A2aAuthContext,
  params: TaskListParams,
) {
  const { contextId, state, limit = 100 } = params;

  if (!contextId) {
    throw new Error("contextId is required");
  }

  const tasks = await prisma.a2aTask.findMany({
    where: {
      contextId,
      ...taskScope(authContext),
      ...(state && { state }),
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 100), // Max 100 tasks
    select: {
      taskId: true,
      skill: true,
      state: true,
      stateReason: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
    },
  });

  return {
    contextId,
    tasks: tasks.map((task) => ({
      taskId: task.taskId,
      skill: task.skill,
      state: task.state,
      stateReason: task.stateReason,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString(),
    })),
  };
}

/**
 * Handle task.cancel - Cancel a task
 */
export async function handleTaskCancel(
  authContext: A2aAuthContext,
  params: TaskCancelParams,
) {
  const { taskId, reason } = params;

  if (!taskId) {
    throw new Error("taskId is required");
  }

  const task = await prisma.a2aTask.findUnique({
    where: {
      taskId,
      ...taskScope(authContext),
    },
  });

  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  // Check if task can be canceled (must not be in terminal state)
  const terminalStates = [
    A2aTaskState.completed,
    A2aTaskState.failed,
    A2aTaskState.canceled,
    A2aTaskState.rejected,
    A2aTaskState.unknown,
  ] as A2aTaskState[];

  if (terminalStates.includes(task.state)) {
    throw new Error(`Cannot cancel task in terminal state: ${task.state}`);
  }

  // Transition to canceled state
  const previousState = task.state;

  await prisma.a2aTask.update({
    where: { id: task.id },
    data: {
      state: A2aTaskState.canceled,
      stateReason: reason || "Canceled by user",
      completedAt: new Date(),
    },
  });

  // Record state transition
  await prisma.a2aTaskHistory.create({
    data: {
      taskId: task.id,
      fromState: previousState,
      toState: A2aTaskState.canceled,
      reason: reason || "Canceled by user",
    },
  });

  logger.info("Canceled A2A task", { taskId, previousState });

  return {
    taskId: task.taskId,
    state: A2aTaskState.canceled,
    stateReason: reason || "Canceled by user",
  };
}

/**
 * Handle context.get - Get all messages in a context
 */
export async function handleContextGet(
  authContext: A2aAuthContext,
  params: ContextGetParams,
) {
  const { contextId, limit = 100 } = params;

  if (!contextId) {
    throw new Error("contextId is required");
  }

  // Verify user has access to this context by checking if they have any tasks in it
  const userTask = await prisma.a2aTask.findFirst({
    where: {
      contextId,
      ...taskScope(authContext),
    },
    select: { id: true },
  });

  if (!userTask) {
    throw new Error(`Context not found or access denied: ${contextId}`);
  }

  const messages = await prisma.a2aMessage.findMany({
    where: { contextId },
    orderBy: { createdAt: "asc" },
    take: Math.min(limit, 1000), // Max 1000 messages
  });

  return {
    contextId,
    messages: messages.map((msg) => ({
      messageId: msg.id,
      role: msg.role,
      content: msg.content,
      contentType: msg.contentType,
      referenceTaskIds: msg.referenceTaskIds,
      createdAt: msg.createdAt.toISOString(),
    })),
  };
}

/**
 * Get skill definition by name
 */
export function getSkillDefinition(
  skillName: string,
): A2aSkillDefinition | undefined {
  return A2A_SKILL_REGISTRY[skillName];
}

/**
 * List all available skills
 */
export function listSkills(): A2aSkillDefinition[] {
  return Object.values(A2A_SKILL_REGISTRY);
}
