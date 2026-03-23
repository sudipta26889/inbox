import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { approveTask } from "@/utils/a2a/task-executor";
import { A2aTaskState } from "@prisma/client";

const logger = createScopedLogger("api/a2a-approvals");

/**
 * A2A Task Approval Management API
 *
 * View and manage tasks that require human approval (auth_required state)
 */

/**
 * GET /api/user/a2a-approvals
 * List all pending approval requests for the current user
 */
export const GET = withAuth("user/a2a-approvals", async (request) => {
  const userId = request.auth.userId;

  const approvals = await prisma.a2aApproval.findMany({
    where: {
      status: "pending",
      task: {
        userId,
        state: A2aTaskState.auth_required,
      },
    },
    include: {
      task: {
        select: {
          id: true,
          taskId: true,
          skill: true,
          input: true,
          contextId: true,
          createdAt: true,
          clientId: true,
        },
      },
    },
    orderBy: {
      requestedAt: "asc",
    },
  });

  return Response.json({
    approvals: approvals.map((approval) => ({
      id: approval.id,
      taskId: approval.task.taskId,
      skill: approval.skill,
      requestData: approval.requestData,
      requestReason: approval.requestReason,
      requestedAt: approval.requestedAt.toISOString(),
      expiresAt: approval.expiresAt?.toISOString(),
      contextId: approval.task.contextId,
      clientId: approval.task.clientId,
    })),
  });
});

export type GetA2aApprovalsResponse = Awaited<ReturnType<typeof GET.json>>;

/**
 * POST /api/user/a2a-approvals/approve
 * Approve a pending task
 */
export const POST = withAuth("user/a2a-approvals", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();

  const { taskId, responseData } = body as {
    taskId: string;
    responseData?: Record<string, unknown>;
  };

  if (!taskId) {
    return Response.json({ error: "taskId is required" }, { status: 400 });
  }

  // Verify the task belongs to this user and is in auth_required state
  const task = await prisma.a2aTask.findFirst({
    where: {
      taskId,
      userId,
      state: A2aTaskState.auth_required,
    },
    select: {
      id: true,
      taskId: true,
      skill: true,
    },
  });

  if (!task) {
    return Response.json(
      { error: "Task not found or not pending approval" },
      { status: 404 },
    );
  }

  try {
    // Approve and execute the task
    await approveTask(task.id, userId, responseData);

    logger.info("Task approved by user", {
      userId,
      taskId,
      skill: task.skill,
    });

    return Response.json({
      success: true,
      taskId,
      message: "Task approved and queued for execution",
    });
  } catch (error: unknown) {
    logger.error("Failed to approve task", {
      userId,
      taskId,
      error: error.message,
    });

    return Response.json(
      { error: `Failed to approve task: ${error.message}` },
      { status: 500 },
    );
  }
});

export type ApproveA2aTaskResponse = Awaited<ReturnType<typeof POST.json>>;
