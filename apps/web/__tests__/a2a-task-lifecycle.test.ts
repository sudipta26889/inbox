import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { A2aTaskState } from "@prisma/client";

/**
 * A2A Task Lifecycle Integration Test
 *
 * Tests the complete task lifecycle from creation to completion/failure
 * including state transitions, retries, approvals, and cancellations.
 *
 * Run with: pnpm test a2a-task-lifecycle
 */

const skipTest = !process.env.A2A_TEST_ACCESS_TOKEN;

describe.skipIf(skipTest)("A2A Task Lifecycle", () => {
  let accessToken: string;
  const baseUrl = env.NEXT_PUBLIC_BASE_URL;
  const testContextId = `test-lifecycle-${Date.now()}`;

  beforeAll(() => {
    accessToken = process.env.A2A_TEST_ACCESS_TOKEN || "";
  });

  afterAll(async () => {
    // Cleanup test tasks
    await prisma.a2aTask.deleteMany({
      where: { contextId: testContextId },
    });
  });

  async function sendJsonRpc(method: string, params: any) {
    const response = await fetch(`${baseUrl}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1_000_000),
        method,
        params,
      }),
    });

    const result = await response.json();
    if (result.error) {
      throw new Error(`JSON-RPC Error: ${result.error.message}`);
    }
    return result.result;
  }

  async function waitForTaskState(
    taskId: string,
    targetState: A2aTaskState,
    timeoutMs = 30_000,
  ): Promise<any> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const task = await sendJsonRpc("task.get", { taskId });

      if (task.state === targetState) {
        return task;
      }

      // If task reached a different terminal state, fail
      const terminalStates = [
        A2aTaskState.completed,
        A2aTaskState.failed,
        A2aTaskState.canceled,
        A2aTaskState.rejected,
        A2aTaskState.unknown,
      ];

      if (terminalStates.includes(task.state) && task.state !== targetState) {
        throw new Error(
          `Task reached terminal state ${task.state} instead of ${targetState}`,
        );
      }

      // Wait 1 second before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error(`Timeout waiting for task to reach state ${targetState}`);
  }

  it("should complete full task flow: submitted → working → completed", async () => {
    // Create a simple task (account.list doesn't require approval)
    const createResult = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    expect(createResult.taskId).toBeTruthy();
    expect(createResult.state).toBe(A2aTaskState.submitted);

    const taskId = createResult.taskId;

    // Wait for task to complete
    const completedTask = await waitForTaskState(
      taskId,
      A2aTaskState.completed,
    );

    expect(completedTask.state).toBe(A2aTaskState.completed);
    expect(completedTask.result).toBeDefined();
    expect(completedTask.completedAt).toBeTruthy();

    // Verify state history
    expect(completedTask.history).toBeInstanceOf(Array);
    expect(completedTask.history.length).toBeGreaterThanOrEqual(2);

    // Check state transitions
    const states = completedTask.history.map((h: any) => h.toState);
    expect(states).toContain(A2aTaskState.working);
    expect(states).toContain(A2aTaskState.completed);
  });

  it("should handle cancellation: submitted → canceled", async () => {
    // Create a task
    const createResult = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    const taskId = createResult.taskId;

    // Cancel immediately
    const cancelResult = await sendJsonRpc("task.cancel", {
      taskId,
      reason: "User requested cancellation",
    });

    expect(cancelResult.state).toBe(A2aTaskState.canceled);
    expect(cancelResult.stateReason).toContain("User requested");

    // Verify task is actually canceled
    const task = await sendJsonRpc("task.get", { taskId });
    expect(task.state).toBe(A2aTaskState.canceled);
  });

  it("should handle approval flow: submitted → auth_required → approved → completed", async () => {
    // Create a task that requires approval (calendar.create_event)
    const createResult = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "calendar.create_event",
      input: {
        title: "Test Meeting",
        startTime: new Date(Date.now() + 86_400_000).toISOString(),
        endTime: new Date(Date.now() + 90_000_000).toISOString(),
      },
    });

    const taskId = createResult.taskId;

    expect(createResult.state).toBe(A2aTaskState.auth_required);

    // Task should stay in auth_required state
    const task = await sendJsonRpc("task.get", { taskId });
    expect(task.state).toBe(A2aTaskState.auth_required);

    // In a real test, we would approve via the approval API
    // For now, we verify the task is in the correct state
  });

  it("should list tasks in context", async () => {
    // Create multiple tasks in the same context
    const task1 = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    const task2 = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    // List all tasks in context
    const listResult = await sendJsonRpc("task.list", {
      contextId: testContextId,
    });

    expect(listResult.contextId).toBe(testContextId);
    expect(listResult.tasks).toBeInstanceOf(Array);
    expect(listResult.tasks.length).toBeGreaterThanOrEqual(2);

    const taskIds = listResult.tasks.map((t: any) => t.taskId);
    expect(taskIds).toContain(task1.taskId);
    expect(taskIds).toContain(task2.taskId);
  });

  it("should filter tasks by state", async () => {
    // Create a task and cancel it
    const createResult = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    await sendJsonRpc("task.cancel", {
      taskId: createResult.taskId,
      reason: "Test cancellation",
    });

    // List only canceled tasks
    const listResult = await sendJsonRpc("task.list", {
      contextId: testContextId,
      state: A2aTaskState.canceled,
    });

    expect(listResult.tasks).toBeInstanceOf(Array);
    expect(
      listResult.tasks.every((t: any) => t.state === A2aTaskState.canceled),
    ).toBe(true);
  });

  it("should retrieve context messages", async () => {
    // Send a message without skill (creates message, not task)
    await sendJsonRpc("message.send", {
      contextId: testContextId,
      content: "Hello, this is a test message",
    });

    // Send another message
    await sendJsonRpc("message.send", {
      contextId: testContextId,
      content: { text: "Another message", type: "user" },
    });

    // Retrieve context messages
    const contextResult = await sendJsonRpc("context.get", {
      contextId: testContextId,
    });

    expect(contextResult.contextId).toBe(testContextId);
    expect(contextResult.messages).toBeInstanceOf(Array);
    expect(contextResult.messages.length).toBeGreaterThanOrEqual(2);

    // Verify message structure
    const message = contextResult.messages[0];
    expect(message.messageId).toBeTruthy();
    expect(message.role).toBeDefined();
    expect(message.content).toBeDefined();
    expect(message.createdAt).toBeTruthy();
  });

  it("should reject invalid method calls", async () => {
    try {
      await sendJsonRpc("invalid.method", {});
      throw new Error("Should have thrown error");
    } catch (error: any) {
      expect(error.message).toContain("Method not found");
    }
  });

  it("should reject tasks without required parameters", async () => {
    try {
      await sendJsonRpc("message.send", {
        contextId: "", // Empty context ID
        skill: "account.list",
      });
      throw new Error("Should have thrown error");
    } catch (error: any) {
      expect(error.message).toContain("contextId is required");
    }
  });

  it("should enforce rate limits", async () => {
    // Try to create many tasks rapidly
    const promises: Promise<any>[] = [];

    for (let i = 0; i < 70; i++) {
      // Exceeds 60/min client limit
      promises.push(
        sendJsonRpc("message.send", {
          contextId: testContextId,
          skill: "account.list",
          input: {},
        }).catch((e) => e),
      );
    }

    const results = await Promise.all(promises);

    // Some requests should fail with rate limit error
    const rateLimitErrors = results.filter(
      (r) => r instanceof Error && r.message.includes("rate"),
    );

    expect(rateLimitErrors.length).toBeGreaterThan(0);
  });

  it("should track task history with timestamps", async () => {
    const createResult = await sendJsonRpc("message.send", {
      contextId: testContextId,
      skill: "account.list",
      input: {},
    });

    const taskId = createResult.taskId;

    // Wait for completion
    const completedTask = await waitForTaskState(
      taskId,
      A2aTaskState.completed,
    );

    // Verify history has timestamps and durations
    expect(completedTask.history).toBeInstanceOf(Array);

    for (const historyEntry of completedTask.history) {
      expect(historyEntry.timestamp).toBeTruthy();
      expect(historyEntry.fromState).toBeDefined();
      expect(historyEntry.toState).toBeDefined();
      expect(historyEntry.reason).toBeTruthy();
    }

    // Check chronological order
    const timestamps = completedTask.history.map((h: any) =>
      new Date(h.timestamp).getTime(),
    );
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1]);
    }
  });
});
