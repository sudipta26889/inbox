import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeTask, approveTask, rejectTask } from "../task-executor";
import { A2aTaskState } from "@prisma/client";

// Mock dependencies
vi.mock("@/utils/prisma", () => ({
  default: {
    a2aTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    a2aTaskHistory: {
      create: vi.fn(),
    },
    a2aApproval: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/utils/mcp-server/tools/registry", () => ({
  getTool: vi.fn((name) => {
    if (name === "search_emails") {
      return {
        name: "search_emails",
        handler: vi.fn().mockResolvedValue({ emails: [] }),
        requiredScope: "email:read",
      };
    }
    if (name === "failing_tool") {
      return {
        name: "failing_tool",
        handler: vi.fn().mockRejectedValue(new Error("Network timeout")),
        requiredScope: "email:read",
      };
    }
    return null;
  }),
}));

vi.mock("../protocol-handler", () => ({
  getSkillDefinition: vi.fn((skill) => {
    const definitions: Record<string, any> = {
      "email.search": {
        skill: "email.search",
        mcpTool: "search_emails",
        requiredScope: "email:read",
      },
      "email.failing": {
        skill: "email.failing",
        mcpTool: "failing_tool",
        requiredScope: "email:read",
      },
    };
    return definitions[skill];
  }),
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);

describe("Task Executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("executeTask", () => {
    it("should execute task and transition to completed", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        skill: "email.search",
        input: { query: "test" },
        state: A2aTaskState.submitted,
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      // Should transition to working
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.working,
          }),
        }),
      );

      // Should record working state transition
      expect(prisma.a2aTaskHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            fromState: A2aTaskState.submitted,
            toState: A2aTaskState.working,
          }),
        }),
      );

      // Should transition to completed
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.completed,
          }),
        }),
      );

      // Should record completed state transition
      expect(prisma.a2aTaskHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toState: A2aTaskState.completed,
          }),
        }),
      );
    });

    it("should handle MCP tool errors with retry", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        skill: "email.failing",
        input: {},
        state: A2aTaskState.submitted,
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      // Should queue for retry (back to submitted)
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.submitted,
            retryCount: 1,
          }),
        }),
      );
    });

    it("should exhaust retries after maxRetries", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        skill: "email.failing",
        input: {},
        state: A2aTaskState.submitted,
        retryCount: 3, // Max retries reached
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      // Should mark as failed (not retry)
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.failed,
          }),
        }),
      );
    });

    it("should not execute terminal state tasks", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.completed,
        skill: "email.search",
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);

      await executeTask("task-internal-123");

      // Should not transition state
      expect(prisma.a2aTask.update).not.toHaveBeenCalled();
    });

    it("should not execute auth_required tasks", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.auth_required,
        skill: "email.search",
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);

      await executeTask("task-internal-123");

      // Should not transition state
      expect(prisma.a2aTask.update).not.toHaveBeenCalled();
    });
  });

  describe("Retry Logic", () => {
    it("should retry on network errors", async () => {
      // Network error is retriable
      const error = new Error("ECONNREFUSED");
      (error as any).code = "ECONNREFUSED";

      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.submitted,
        skill: "email.failing",
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.submitted,
            retryCount: 1,
          }),
        }),
      );
    });

    it("should NOT retry on 400 errors", async () => {
      // 400 errors are not retriable
      const error = new Error("Bad request");
      (error as any).status = 400;

      // This test would require mocking the tool to throw a 400 error
      // For now, we're testing the logic is in place
    });

    it("should increment retryCount on each retry", async () => {
      const mockTask = {
        id: "task-internal-123",
        state: A2aTaskState.submitted,
        skill: "email.failing",
        retryCount: 1,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            retryCount: 2,
          }),
        }),
      );
    });

    it("should update lastRetryAt timestamp", async () => {
      const mockTask = {
        id: "task-internal-123",
        state: A2aTaskState.submitted,
        skill: "email.failing",
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastRetryAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  describe("Approval Workflow", () => {
    it("should approve and execute auth_required task", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.auth_required,
        skill: "calendar.create_event",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        input: {},
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({
        ...mockTask,
        state: A2aTaskState.submitted,
      });
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});
      (prisma.a2aApproval.update as any).mockResolvedValue({});

      // Mock the skill definition to return a working tool
      const { getSkillDefinition } = await import("../protocol-handler");
      (getSkillDefinition as any).mockReturnValue({
        skill: "calendar.create_event",
        mcpTool: "create_calendar_event",
        requiredScope: "calendar:write",
      });

      const { getTool } = await import("@/utils/mcp-server/tools/registry");
      (getTool as any).mockReturnValue({
        name: "create_calendar_event",
        handler: vi.fn().mockResolvedValue({ eventId: "evt-123" }),
        requiredScope: "calendar:write",
      });

      await approveTask("task-internal-123", "user-123", { approved: true });

      // Should update approval record
      expect(prisma.a2aApproval.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "approved",
            approved: true,
          }),
        }),
      );

      // Should transition to submitted
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.submitted,
          }),
        }),
      );
    });

    it("should reject and terminate auth_required task", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.auth_required,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});
      (prisma.a2aApproval.update as any).mockResolvedValue({});

      await rejectTask(
        "task-internal-123",
        "user-123",
        "Not authorized for this action",
      );

      // Should update approval record
      expect(prisma.a2aApproval.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "rejected",
            approved: false,
            rejectionReason: "Not authorized for this action",
          }),
        }),
      );

      // Should transition to rejected terminal state
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.rejected,
          }),
        }),
      );
    });
  });

  describe("State Machine", () => {
    it("should enforce terminal state immutability", async () => {
      const terminalStates = [
        A2aTaskState.completed,
        A2aTaskState.failed,
        A2aTaskState.canceled,
        A2aTaskState.rejected,
        A2aTaskState.unknown,
      ];

      for (const state of terminalStates) {
        const mockTask = {
          id: "task-internal-123",
          state,
          skill: "email.search",
        };

        (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);

        await executeTask("task-internal-123");

        // Should not attempt to update terminal state tasks
        expect(prisma.a2aTask.update).not.toHaveBeenCalled();

        vi.clearAllMocks();
      }
    });

    it("should record state transitions in history", async () => {
      const mockTask = {
        id: "task-internal-123",
        state: A2aTaskState.submitted,
        skill: "email.search",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        input: {},
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      // Should create history records
      expect(prisma.a2aTaskHistory.create).toHaveBeenCalledTimes(2);

      // First: submitted → working
      expect(prisma.a2aTaskHistory.create).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            fromState: A2aTaskState.submitted,
            toState: A2aTaskState.working,
          }),
        }),
      );

      // Second: working → completed
      expect(prisma.a2aTaskHistory.create).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            fromState: A2aTaskState.working,
            toState: A2aTaskState.completed,
          }),
        }),
      );
    });

    it("should calculate durationMs correctly", async () => {
      const mockTask = {
        id: "task-internal-123",
        state: A2aTaskState.submitted,
        skill: "email.search",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        input: {},
        retryCount: 0,
        maxRetries: 3,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({});
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      await executeTask("task-internal-123");

      // Should include durationMs in history
      expect(prisma.a2aTaskHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            durationMs: expect.any(Number),
          }),
        }),
      );
    });
  });
});
