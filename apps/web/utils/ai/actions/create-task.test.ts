import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { executeCreateTaskAction } from "@/utils/ai/actions/create-task";
import { TaskpilotClient } from "@/utils/taskpilot/client";

vi.mock("@/utils/prisma");

vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigForUser: vi
    .fn()
    .mockResolvedValue({ apiKey: "tk", workspaceSlug: "acme" }),
  getTaskpilotClientForUser: vi.fn(),
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

const userId = "user-1";
const emailAccountId = "acc-1";
const ruleId = "rule-1";

const chatCompletionObject = vi.fn(async () => ({
  object: {
    projectId: "p1",
    title: "Help! login broken",
    description_html: '<p>x</p><a href="{{INBOX_LINK}}">Open</a>',
    priority: "high",
    labelNames: [],
  },
}));

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.emailTaskLink.findUnique.mockReset();
  prisma.emailTaskLink.upsert.mockReset();
  chatCompletionObject.mockClear();

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

describe("executeCreateTaskAction", () => {
  it("creates a task and writes EmailTaskLink with source=RULE + ruleId", async () => {
    prisma.emailTaskLink.findUnique.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-1",
      emailAccountId,
      gmailMessageId: "msg-rule-1",
      threadId: "thread-1",
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "SUP-7",
      source: "RULE",
      ruleId,
      createdAt: new Date(),
    } as never);

    const result = await executeCreateTaskAction({
      email: {
        id: "msg-rule-1",
        threadId: "thread-1",
        subject: "Help! login broken",
        from: "cust@example.com",
        snippet: "I cannot log in",
        bodyText: "I cannot log in to my account.",
        internalDate: String(Date.now()),
        deepLink: "https://mail.google.com/.../msg-rule-1",
      },
      emailAccountId,
      userId,
      rule: {
        id: ruleId,
        instructions: "Identify support; route to Acme Support",
      },
      chatCompletionObject,
    });

    expect(result).toMatchObject({
      taskpilotIdentifier: "SUP-7",
      alreadyExisted: false,
    });
    // The link write captured source=RULE and ruleId
    const upsertCall = prisma.emailTaskLink.upsert.mock.calls[0]?.[0] as {
      create: { source: string; ruleId: string | null };
    };
    expect(upsertCall.create.source).toBe("RULE");
    expect(upsertCall.create.ruleId).toBe(ruleId);
    // chat function was invoked with the rule's instructions in the prompt
    expect(chatCompletionObject).toHaveBeenCalledTimes(1);
    const promptArg = (
      chatCompletionObject.mock.calls[0]?.[0] as {
        prompt: string;
      }
    ).prompt;
    expect(promptArg).toContain("Identify support");
  });

  it("short-circuits if EmailTaskLink already exists", async () => {
    prisma.emailTaskLink.findUnique.mockResolvedValue({
      id: "existing",
      emailAccountId,
      gmailMessageId: "msg-existing",
      threadId: null,
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "old",
      taskpilotIdentifier: "SUP-1",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);

    const createSpy = vi.spyOn(TaskpilotClient.prototype, "createWorkItem");
    const result = await executeCreateTaskAction({
      email: {
        id: "msg-existing",
        threadId: null,
        subject: "x",
        from: "x@example.com",
        snippet: "",
        bodyText: "",
        internalDate: "0",
        deepLink: "https://x",
      },
      emailAccountId,
      userId,
      rule: { id: ruleId, instructions: "" },
      chatCompletionObject,
    });
    expect(result.taskpilotIdentifier).toBe("SUP-1");
    expect(result.alreadyExisted).toBe(true);
    expect(createSpy).not.toHaveBeenCalled();
    expect(chatCompletionObject).not.toHaveBeenCalled();
  });
});
