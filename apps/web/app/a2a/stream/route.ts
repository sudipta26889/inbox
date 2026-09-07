import { type A2aAuthContext, withA2aAuth } from "@/utils/a2a/auth";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { A2aTaskState } from "@/generated/prisma/enums";
import { taskScope } from "@/utils/a2a/task-scope";
import { toWireState } from "@/utils/a2a/wire-state";

const logger = createScopedLogger("a2a-stream");

/**
 * A2A SSE Streaming Endpoint
 *
 * Provides real-time Server-Sent Events (SSE) stream for task state updates.
 * Clients can subscribe to updates for specific tasks instead of polling.
 *
 * GET /a2a/stream?taskId=<id>
 *
 * Returns:
 * - event: ping - Keep-alive ping every 15 seconds
 * - event: task.state_changed - Task state changed
 * - event: task.completed - Task completed
 * - event: task.failed - Task failed
 * - event: task.error - Streaming error
 * - event: final - Final state reached (completed, failed, canceled, rejected)
 */

export const maxDuration = 300; // 5 minutes max connection time
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // withA2aAuth THROWS a Response on failure and returns the context on
  // success — it has no `authorized` field. Reading one meant the guard always
  // fired and every stream answered `new Response(undefined)`, an empty 200.
  //
  // No scope is required beyond a valid token: the task lookup below is keyed
  // on authResult.userId, so a client can only ever stream its own tasks.
  // (The previous "task:read" is not a scope this server issues, so no token
  // could have satisfied it either.)
  let authResult: A2aAuthContext;
  try {
    authResult = await withA2aAuth(request, []);
  } catch (authResponse) {
    if (authResponse instanceof Response) return authResponse;
    throw authResponse;
  }

  const { searchParams } = new URL(request.url);
  const taskId = searchParams.get("taskId");

  if (!taskId) {
    return new Response("Missing taskId parameter", {
      status: 400,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Verify task exists and user has access
  const task = await prisma.a2aTask.findUnique({
    where: {
      taskId,
      ...taskScope(authResult),
    },
    select: {
      id: true,
      taskId: true,
      state: true,
    },
  });

  if (!task) {
    return new Response("Task not found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  }

  const streamedTaskId = task.taskId;

  logger.info("Starting SSE stream for task", {
    taskId: streamedTaskId,
    userId: authResult.userId,
    clientId: authResult.clientId,
  });

  // Create SSE stream
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const terminalStates: A2aTaskState[] = [
        A2aTaskState.completed,
        A2aTaskState.failed,
        A2aTaskState.canceled,
        A2aTaskState.rejected,
        A2aTaskState.unknown,
      ];

      let lastState = task.state;
      let isTerminal = terminalStates.includes(lastState);
      let pingInterval: NodeJS.Timeout | null = null;

      // Send initial state
      const initialTask = await getTaskData(task.id);
      sendEvent(controller, encoder, "task.state_changed", initialTask);

      // If already in terminal state, send final event and close
      if (isTerminal) {
        sendEvent(controller, encoder, "final", initialTask);
        controller.close();
        return;
      }

      // Set up ping interval (every 15 seconds)
      pingInterval = setInterval(() => {
        sendEvent(controller, encoder, "ping", {
          timestamp: new Date().toISOString(),
        });
      }, 15_000);

      // Poll for state changes
      const pollInterval = setInterval(async () => {
        try {
          const currentTask = await prisma.a2aTask.findUnique({
            where: { id: task.id },
            select: { state: true },
          });

          if (!currentTask) {
            sendEvent(controller, encoder, "error", {
              error: "Task not found",
            });
            cleanup();
            return;
          }

          // Check if state changed
          if (currentTask.state !== lastState) {
            const taskData = await getTaskData(task.id);
            lastState = currentTask.state;
            isTerminal = terminalStates.includes(lastState);

            // Send state change event
            sendEvent(controller, encoder, "task.state_changed", taskData);

            // Send specific event based on state
            switch (currentTask.state) {
              case A2aTaskState.completed:
                sendEvent(controller, encoder, "task.completed", taskData);
                break;
              case A2aTaskState.failed:
                sendEvent(controller, encoder, "task.failed", taskData);
                break;
            }

            // If terminal state, send final event and close
            if (isTerminal) {
              sendEvent(controller, encoder, "final", taskData);
              cleanup();
            }
          }
        } catch (error) {
          logger.error("Error polling task state", {
            taskId: task.taskId,
            error,
          });
          sendEvent(controller, encoder, "error", {
            error,
          });
          cleanup();
        }
      }, 2000); // Poll every 2 seconds

      function cleanup() {
        if (pingInterval) clearInterval(pingInterval);
        clearInterval(pollInterval);
        controller.close();

        logger.info("SSE stream closed", {
          taskId: streamedTaskId,
          finalState: lastState,
        });
      }

      // Handle client disconnect
      request.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    },
  });
}

/**
 * Get full task data for SSE event
 */
async function getTaskData(taskInternalId: string) {
  const task = await prisma.a2aTask.findUnique({
    where: { id: taskInternalId },
    select: {
      taskId: true,
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
      history: {
        orderBy: { timestamp: "asc" },
        take: 100,
      },
    },
  });

  if (!task) {
    throw new Error("Task not found");
  }

  return {
    id: task.taskId,
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
    history: task.history.map((h) => ({
      from_state: h.fromState,
      to_state: h.toState,
      reason: h.reason,
      timestamp: h.timestamp.toISOString(),
      duration_ms: h.durationMs,
    })),
  };
}

/**
 * Send SSE event to client
 */
function sendEvent(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  event: string,
  data: unknown,
) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  controller.enqueue(encoder.encode(message));
}
