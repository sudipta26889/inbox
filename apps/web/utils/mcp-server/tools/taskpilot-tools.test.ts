import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { convertToTaskpilotTask } from "./taskpilot-tools";

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

vi.mock("@/utils/taskpilot/llm", () => ({
  buildTaskpilotChatCompletion: vi.fn(async () =>
    vi.fn(async () => ({
      object: {
        projectId: "p1",
        title: "Stub title",
        description_html: '<p>x</p><a href="{{INBOX_LINK}}">Open</a>',
        priority: "medium",
        labelNames: [],
      },
    })),
  ),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    getMessage: vi.fn(async (id: string) => ({
      id,
      threadId: "thr-1",
      headers: { subject: "Hello", from: "x@example.com" },
      snippet: "snip",
      textPlain: "body",
      internalDate: String(Date.now()),
    })),
  })),
}));

const ctx = {
  userId: "user-1",
  emailAccountId: "acc-1",
  clientId: "client-1",
  scopes: ["email:write"],
};

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.emailAccount.findFirst.mockReset();
  prisma.emailTaskLink.findUnique.mockReset();
  prisma.emailTaskLink.upsert.mockReset();

  prisma.emailAccount.findFirst.mockResolvedValue({
    id: "acc-1",
    email: "alex@example.com",
    userId: "user-1",
    account: { provider: "google" },
  } as never);

  vi.spyOn(TaskpilotClient.prototype, "listProjects").mockResolvedValue([
    { id: "p1", identifier: "WEB", name: "Web", description: null },
  ]);
  vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);
  vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
    id: "issue-1",
    identifier: "WEB-1",
    sequence_id: 1,
    alreadyExisted: false,
  });
  vi.spyOn(TaskpilotClient.prototype, "addLink").mockResolvedValue();
});

describe("convertToTaskpilotTask", () => {
  it("preview returns a draft without creating a task", async () => {
    prisma.emailTaskLink.findUnique.mockResolvedValue(null);
    const result = await convertToTaskpilotTask(ctx, {
      emailId: "msg-1",
      preview: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        alreadyExisted: false,
      });
      expect(result.data).toHaveProperty("draft");
    }
    // No work-item was created
    expect(prisma.emailTaskLink.upsert).not.toHaveBeenCalled();
  });

  it("commit creates the task and returns identifier", async () => {
    prisma.emailTaskLink.findUnique.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-1",
      emailAccountId: "acc-1",
      gmailMessageId: "msg-2",
      threadId: "thr-1",
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "WEB-1",
      source: "CHAT",
      ruleId: null,
      createdAt: new Date(),
    } as never);

    const result = await convertToTaskpilotTask(ctx, {
      emailId: "msg-2",
      preview: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        taskpilotIdentifier: "WEB-1",
      });
    }
    const upsertCall = prisma.emailTaskLink.upsert.mock.calls[0]?.[0] as {
      create: { source: string };
    };
    expect(upsertCall.create.source).toBe("CHAT");
  });

  it("returns VALIDATION_ERROR for missing emailId", async () => {
    const result = await convertToTaskpilotTask(ctx, { preview: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
