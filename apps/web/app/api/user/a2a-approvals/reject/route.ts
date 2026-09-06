import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { rejectTask } from "@/utils/a2a/task-executor";
import { A2aTaskState } from "@/generated/prisma/enums";

const logger = createScopedLogger("api/a2a-approvals-reject");

/**
 * POST /api/user/a2a-approvals/reject
 * Reject a pending task
 */
export const POST = withAuth("user/a2a-approvals/reject", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();

  const { taskId, rejectionReason } = body as {
    taskId: string;
    rejectionReason: string;
  };

  if (!taskId) {
    return Response.json({ error: "taskId is required" }, { status: 400 });
  }

  if (!rejectionReason || rejectionReason.trim().length === 0) {
    return Response.json(
      { error: "rejectionReason is required" },
      { status: 400 },
    );
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
    // Reject the task
    await rejectTask(task.id, userId, rejectionReason);

    logger.info("Task rejected by user", {
      userId,
      taskId,
      skill: task.skill,
      reason: rejectionReason,
    });

    return Response.json({
      success: true,
      taskId,
      message: "Task rejected",
    });
  } catch (error) {
    logger.error("Failed to reject task", {
      userId,
      taskId,
      error,
    });

    return Response.json(
      {
        error: `Failed to reject task: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 500 },
    );
  }
});

export type RejectA2aTaskResponse = { success: true } | { error: string };
