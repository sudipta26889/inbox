import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { ActionType } from "@/generated/prisma/enums";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import { runActionFunction } from "@/utils/ai/actions";
import { createScopedLogger } from "@/utils/logger";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import type { ParsedMessage } from "@/utils/types";

vi.mock("@/utils/prisma");

vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigForUser: vi
    .fn()
    .mockResolvedValue({ apiKey: "tk", workspaceSlug: "acme" }),
}));

vi.mock("@/utils/taskpilot/cache", () => ({
  taskpilotCache: {
    getProjects: vi.fn(
      async (_userId: string, loader: () => Promise<unknown>) => loader(),
    ),
    getLabels: vi.fn(
      async (
        _userId: string,
        _projectId: string,
        loader: () => Promise<unknown>,
      ) => loader(),
    ),
    invalidateUser: vi.fn(),
  },
}));

// Existing mocks the dispatcher test suite uses
vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis/reply", () => ({
  getReplyWithConfidence: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/utils/attachments/draft-attachments", () => ({
  resolveDraftAttachments: vi.fn().mockResolvedValue([]),
  selectDraftAttachmentsForRule: vi.fn().mockResolvedValue({
    selectedAttachments: [],
    attachmentContext: null,
  }),
}));

describe("runActionFunction — ActionType.CREATE_TASK", () => {
  const logger = createScopedLogger("test");
  const email = {
    id: "message-1",
    threadId: "thread-1",
    headers: {
      from: "customer@example.com",
      to: "user@example.com",
      subject: "Login broken",
      date: "2026-01-01T12:00:00.000Z",
      "message-id": "<message-1@example.com>",
    },
    textPlain: "I cannot log in to my account.",
    textHtml: "<p>I cannot log in to my account.</p>",
    snippet: "I cannot log in",
    attachments: [],
    internalDate: "1700000000000",
  } as ParsedMessage;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.rule.findUnique.mockResolvedValue({
      instructions: "Identify customer support; route to Acme Support",
    } as never);
    prisma.emailTaskLink.findUnique.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-1",
      emailAccountId: "account-1",
      gmailMessageId: "message-1",
      threadId: "thread-1",
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "SUP-7",
      source: "RULE",
      ruleId: "rule-1",
      createdAt: new Date(),
    } as never);

    vi.spyOn(TaskpilotClient.prototype, "listProjects").mockResolvedValue([
      {
        id: "p1",
        identifier: "SUP",
        name: "Acme Support",
        description: "Customer support",
      },
    ]);
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);
    vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
      id: "issue-1",
      identifier: "SUP-7",
      sequence_id: 7,
      alreadyExisted: false,
    });
    vi.spyOn(TaskpilotClient.prototype, "addLink").mockResolvedValue();
  });

  it("creates a TaskPilot task via the rule dispatcher", async () => {
    const client = createMockEmailProvider();
    const result = await runActionFunction({
      client,
      email,
      action: {
        id: "action-1",
        type: ActionType.CREATE_TASK,
      } as never,
      userEmail: "user@example.com",
      userId: "user-1",
      emailAccountId: "account-1",
      executedRule: {
        id: "executed-rule-1",
        threadId: "thread-1",
        emailAccountId: "account-1",
        ruleId: "rule-1",
      } as never,
      logger,
    });

    expect(result).toMatchObject({
      success: true,
      taskpilotIdentifier: "SUP-7",
      alreadyExisted: false,
    });

    // Idempotency layer wrote the link with source=RULE + ruleId
    expect(prisma.emailTaskLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          source: "RULE",
          ruleId: "rule-1",
        }),
      }),
    );
  });

  it("short-circuits when the email is already linked", async () => {
    prisma.emailTaskLink.findUnique.mockResolvedValue({
      id: "existing",
      emailAccountId: "account-1",
      gmailMessageId: "message-1",
      threadId: "thread-1",
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "old",
      taskpilotIdentifier: "SUP-1",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);
    const createSpy = vi.spyOn(TaskpilotClient.prototype, "createWorkItem");

    const client = createMockEmailProvider();
    const result = await runActionFunction({
      client,
      email,
      action: { id: "action-1", type: ActionType.CREATE_TASK } as never,
      userEmail: "user@example.com",
      userId: "user-1",
      emailAccountId: "account-1",
      executedRule: {
        id: "executed-rule-1",
        threadId: "thread-1",
        emailAccountId: "account-1",
        ruleId: "rule-1",
      } as never,
      logger,
    });

    expect(result).toMatchObject({
      success: true,
      taskpilotIdentifier: "SUP-1",
      alreadyExisted: true,
    });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
