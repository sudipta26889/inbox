import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import prisma from "@/utils/__mocks__/prisma";
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

/**
 * CREATE_TASK is a signal, not a create. The rule dispatcher records that the
 * rule fired; `maybeRouteToTaskPilot` (see utils/taskpilot/route.test.ts) is
 * what inspects executedRules and decides between CREATE and COMMENT_ON.
 *
 * These tests pin that boundary: creation must NOT leak back into the action,
 * or the same email gets a task twice — once here and once from the hook.
 */
describe("runActionFunction — ActionType.CREATE_TASK", () => {
  const logger = createScopedLogger("test");
  const email: ParsedMessage = {
    id: "message-1",
    threadId: "thread-1",
    historyId: "history-1",
    subject: "Login broken",
    date: "2026-01-01T12:00:00.000Z",
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
    inline: [],
    internalDate: "1700000000000",
  };

  const createWorkItem = vi.spyOn(TaskpilotClient.prototype, "createWorkItem");

  function runCreateTaskAction() {
    return runActionFunction({
      client: createMockEmailProvider(),
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
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
  });

  it("succeeds without creating a TaskPilot work item", async () => {
    const result = await runCreateTaskAction();

    expect(result).toMatchObject({ success: true });
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("does not write an email/task link itself", async () => {
    // The link is the hook's idempotency key. Writing it here would make the
    // hook think the email was already handled and skip the real decision.
    await runCreateTaskAction();

    expect(prisma.emailTaskLink.upsert).not.toHaveBeenCalled();
  });

  it("stays a no-op when the email is already linked", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue({
      id: "link-1",
      taskpilotIdentifier: "SUP-7",
    } as never);

    const result = await runCreateTaskAction();

    expect(result).toMatchObject({ success: true });
    expect(createWorkItem).not.toHaveBeenCalled();
  });
});
