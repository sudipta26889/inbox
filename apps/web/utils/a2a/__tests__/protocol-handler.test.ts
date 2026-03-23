import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleMessageSend,
  handleTaskGet,
  handleTaskList,
  handleTaskCancel,
  handleContextGet,
  A2A_SKILL_REGISTRY,
} from "../protocol-handler";
import type { A2aAuthContext } from "../auth";
import { A2aTaskState } from "@prisma/client";

// Mock dependencies
vi.mock("@/utils/prisma", () => ({
  default: {
    a2aTask: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    a2aTaskHistory: {
      create: vi.fn(),
    },
    a2aMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    a2aApproval: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../task-executor", () => ({
  executeTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id-123"),
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);
const { executeTask } = await import("../task-executor");

// Test fixtures
const mockAuthContext: A2aAuthContext = {
  userId: "user-123",
  emailAccountId: "email-account-456",
  clientId: "client-789",
  scopes: ["email:read", "email:write", "calendar:write"],
  tokenPayload: {
    sub: "user-123",
    email: "test@example.com",
    email_account_id: "email-account-456",
    scope: "email:read email:write calendar:write",
    client_id: "client-789",
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    jti: "token-jti-123",
    token_type: "access",
  },
};

describe("A2A Protocol Handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handleMessageSend", () => {
    it("should create a message when no skill provided", async () => {
      (prisma.a2aMessage.create as any).mockResolvedValue({
        id: "msg-123",
        contextId: "ctx-abc",
        role: "user",
        content: { text: "Hello" },
      });

      const result = await handleMessageSend(mockAuthContext, {
        contextId: "ctx-abc",
        content: "Hello",
      });

      expect(result).toEqual({
        contextId: "ctx-abc",
        messageId: "test-id-123",
      });

      expect(prisma.a2aMessage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          contextId: "ctx-abc",
          role: "user",
          content: "Hello",
        }),
      });
    });

    it("should create a task for valid skill", async () => {
      (prisma.a2aTask.create as any).mockResolvedValue({
        id: "task-internal-123",
        taskId: "test-id-123",
        userId: "user-123",
        emailAccountId: "email-account-456",
        clientId: "client-789",
        contextId: "ctx-abc",
        skill: "email.search",
        input: { query: "test" },
        state: A2aTaskState.submitted,
        requiresApproval: false,
        retryCount: 0,
        maxRetries: 3,
      });

      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      const result = await handleMessageSend(mockAuthContext, {
        contextId: "ctx-abc",
        skill: "email.search",
        input: { query: "test" },
      });

      expect(result).toEqual({
        contextId: "ctx-abc",
        taskId: "test-id-123",
        state: A2aTaskState.submitted,
      });

      expect(prisma.a2aTask.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          skill: "email.search",
          state: A2aTaskState.submitted,
          requiresApproval: false,
        }),
      });

      expect(executeTask).toHaveBeenCalledWith("task-internal-123");
    });

    it("should reject unknown skills", async () => {
      await expect(
        handleMessageSend(mockAuthContext, {
          contextId: "ctx-abc",
          skill: "unknown.skill",
          input: {},
        }),
      ).rejects.toThrow("Unknown skill: unknown.skill");
    });

    it("should enforce scope requirements", async () => {
      const limitedAuthContext = {
        ...mockAuthContext,
        scopes: ["email:read"],
      };

      await expect(
        handleMessageSend(limitedAuthContext, {
          contextId: "ctx-abc",
          skill: "email.send",
          input: {},
        }),
      ).rejects.toThrow("email:write");
    });

    it("should mark task as auth_required for sensitive skills", async () => {
      (prisma.a2aTask.create as any).mockResolvedValue({
        id: "task-internal-456",
        taskId: "test-id-123",
        state: A2aTaskState.auth_required,
        skill: "calendar.create_event",
        requiresApproval: true,
      });

      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});
      (prisma.a2aApproval.create as any).mockResolvedValue({});

      const result = await handleMessageSend(mockAuthContext, {
        contextId: "ctx-abc",
        skill: "calendar.create_event",
        input: { title: "Meeting", startTime: "2026-03-24T10:00:00Z" },
      });

      expect(result.state).toBe(A2aTaskState.auth_required);
      expect(prisma.a2aApproval.create).toHaveBeenCalled();
      expect(executeTask).not.toHaveBeenCalled();
    });

    it("should validate contextId is required", async () => {
      await expect(
        handleMessageSend(mockAuthContext, {
          contextId: "",
          skill: "email.search",
        }),
      ).rejects.toThrow("contextId is required");
    });
  });

  describe("handleTaskGet", () => {
    it("should return task details with history", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        contextId: "ctx-abc",
        skill: "email.search",
        state: A2aTaskState.completed,
        stateReason: "Task completed successfully",
        input: { query: "test" },
        result: { emails: [] },
        error: null,
        artifacts: null,
        referenceTaskIds: [],
        createdAt: new Date("2026-03-23T10:00:00Z"),
        updatedAt: new Date("2026-03-23T10:01:00Z"),
        completedAt: new Date("2026-03-23T10:01:00Z"),
        history: [
          {
            fromState: A2aTaskState.submitted,
            toState: A2aTaskState.working,
            reason: "Executing task",
            timestamp: new Date("2026-03-23T10:00:30Z"),
            durationMs: 30_000,
          },
          {
            fromState: A2aTaskState.working,
            toState: A2aTaskState.completed,
            reason: "Task completed successfully",
            timestamp: new Date("2026-03-23T10:01:00Z"),
            durationMs: 30_000,
          },
        ],
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);

      const result = await handleTaskGet(mockAuthContext, {
        taskId: "task-public-123",
      });

      expect(result.taskId).toBe("task-public-123");
      expect(result.state).toBe(A2aTaskState.completed);
      expect(result.history).toHaveLength(2);
      expect(result.history[0].fromState).toBe(A2aTaskState.submitted);
    });

    it("should reject access to other users' tasks", async () => {
      (prisma.a2aTask.findUnique as any).mockResolvedValue(null);

      await expect(
        handleTaskGet(mockAuthContext, { taskId: "task-other-user" }),
      ).rejects.toThrow("Task not found");
    });

    it("should validate taskId is required", async () => {
      await expect(
        handleTaskGet(mockAuthContext, { taskId: "" }),
      ).rejects.toThrow("taskId is required");
    });
  });

  describe("handleTaskList", () => {
    it("should filter tasks by contextId", async () => {
      const mockTasks = [
        {
          taskId: "task-1",
          skill: "email.search",
          state: A2aTaskState.completed,
          stateReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
        },
        {
          taskId: "task-2",
          skill: "email.get",
          state: A2aTaskState.completed,
          stateReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: new Date(),
        },
      ];

      (prisma.a2aTask.findMany as any).mockResolvedValue(mockTasks);

      const result = await handleTaskList(mockAuthContext, {
        contextId: "ctx-abc",
      });

      expect(result.tasks).toHaveLength(2);
      expect(result.contextId).toBe("ctx-abc");
    });

    it("should filter tasks by state", async () => {
      (prisma.a2aTask.findMany as any).mockResolvedValue([
        {
          taskId: "task-1",
          skill: "email.search",
          state: A2aTaskState.submitted,
          stateReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          completedAt: null,
        },
      ]);

      await handleTaskList(mockAuthContext, {
        contextId: "ctx-abc",
        state: A2aTaskState.submitted,
      });

      expect(prisma.a2aTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            state: A2aTaskState.submitted,
          }),
        }),
      );
    });

    it("should limit results to 100", async () => {
      (prisma.a2aTask.findMany as any).mockResolvedValue([]);

      await handleTaskList(mockAuthContext, {
        contextId: "ctx-abc",
        limit: 500,
      });

      expect(prisma.a2aTask.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        }),
      );
    });

    it("should validate contextId is required", async () => {
      await expect(
        handleTaskList(mockAuthContext, { contextId: "" }),
      ).rejects.toThrow("contextId is required");
    });
  });

  describe("handleTaskCancel", () => {
    it("should cancel a submitted task", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.submitted,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);
      (prisma.a2aTask.update as any).mockResolvedValue({
        ...mockTask,
        state: A2aTaskState.canceled,
      });
      (prisma.a2aTaskHistory.create as any).mockResolvedValue({});

      const result = await handleTaskCancel(mockAuthContext, {
        taskId: "task-public-123",
        reason: "User requested cancellation",
      });

      expect(result.state).toBe(A2aTaskState.canceled);
      expect(prisma.a2aTask.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            state: A2aTaskState.canceled,
          }),
        }),
      );
    });

    it("should reject canceling terminal state tasks", async () => {
      const mockTask = {
        id: "task-internal-123",
        taskId: "task-public-123",
        state: A2aTaskState.completed,
      };

      (prisma.a2aTask.findUnique as any).mockResolvedValue(mockTask);

      await expect(
        handleTaskCancel(mockAuthContext, {
          taskId: "task-public-123",
        }),
      ).rejects.toThrow("Cannot cancel task in terminal state");
    });

    it("should validate taskId is required", async () => {
      await expect(
        handleTaskCancel(mockAuthContext, { taskId: "" }),
      ).rejects.toThrow("taskId is required");
    });
  });

  describe("handleContextGet", () => {
    it("should return all messages in context", async () => {
      const mockMessages = [
        {
          id: "msg-1",
          role: "user",
          content: { text: "Hello" },
          contentType: "text",
          referenceTaskIds: [],
          createdAt: new Date("2026-03-23T10:00:00Z"),
        },
        {
          id: "msg-2",
          role: "agent",
          content: { text: "Hi there!" },
          contentType: "text",
          referenceTaskIds: [],
          createdAt: new Date("2026-03-23T10:01:00Z"),
        },
      ];

      (prisma.a2aTask.findFirst as any).mockResolvedValue({ id: "task-123" });
      (prisma.a2aMessage.findMany as any).mockResolvedValue(mockMessages);

      const result = await handleContextGet(mockAuthContext, {
        contextId: "ctx-abc",
      });

      expect(result.messages).toHaveLength(2);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[1].role).toBe("agent");
    });

    it("should verify user access to context", async () => {
      (prisma.a2aTask.findFirst as any).mockResolvedValue(null);

      await expect(
        handleContextGet(mockAuthContext, { contextId: "ctx-other-user" }),
      ).rejects.toThrow("Context not found or access denied");
    });

    it("should limit to 1000 messages", async () => {
      (prisma.a2aTask.findFirst as any).mockResolvedValue({ id: "task-123" });
      (prisma.a2aMessage.findMany as any).mockResolvedValue([]);

      await handleContextGet(mockAuthContext, {
        contextId: "ctx-abc",
        limit: 5000,
      });

      expect(prisma.a2aMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 1000,
        }),
      );
    });

    it("should validate contextId is required", async () => {
      await expect(
        handleContextGet(mockAuthContext, { contextId: "" }),
      ).rejects.toThrow("contextId is required");
    });
  });

  describe("Skill Registry", () => {
    it("should have all 10 skills defined", () => {
      const expectedSkills = [
        "email.search",
        "email.get",
        "email.send",
        "calendar.search",
        "calendar.get_event",
        "calendar.availability",
        "calendar.create_event",
        "automation.list_rules",
        "stats.email_analytics",
        "account.list",
      ];

      expectedSkills.forEach((skill) => {
        expect(A2A_SKILL_REGISTRY[skill]).toBeDefined();
        expect(A2A_SKILL_REGISTRY[skill].skill).toBe(skill);
        expect(A2A_SKILL_REGISTRY[skill].mcpTool).toBeDefined();
        expect(A2A_SKILL_REGISTRY[skill].requiredScope).toBeDefined();
      });
    });

    it("should have correct scope mappings", () => {
      expect(A2A_SKILL_REGISTRY["email.search"].requiredScope).toBe(
        "email:read",
      );
      expect(A2A_SKILL_REGISTRY["email.send"].requiredScope).toBe(
        "email:write",
      );
      expect(A2A_SKILL_REGISTRY["calendar.create_event"].requiredScope).toBe(
        "calendar:write",
      );
    });

    it("should mark calendar.create_event as requiring approval", () => {
      expect(A2A_SKILL_REGISTRY["calendar.create_event"].requiresApproval).toBe(
        true,
      );
    });
  });
});
