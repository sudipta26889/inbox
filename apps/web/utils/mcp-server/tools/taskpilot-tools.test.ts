import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectMcpData } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { decidePass1 } from "@/utils/taskpilot/decide";
import { convertToTaskpilotTask } from "./taskpilot-tools";

vi.mock("@/utils/prisma");

// Indexing for cross-thread dedupe is fire-and-forget and talks to TaskPilot and
// the embeddings service. It has its own tests; here it must not reach a host.
vi.mock("@/utils/taskpilot/reindex", () => ({
  reindexTask: vi.fn().mockResolvedValue(undefined),
}));

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

vi.mock("@/utils/taskpilot/decide", () => ({
  decidePass1: vi.fn(async () => ({
    ok: true,
    decision: {
      action: "CREATE",
      draft: {
        projectId: "p1",
        title: "Stub title",
        descriptionHtml: "<p>x</p>",
        priority: "medium",
        labelNames: [],
        targetDate: null,
      },
    },
    model: "stub",
    effort: "low",
    durationMs: 0,
    usage: null,
  })),
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
  prisma.emailTaskLink.findFirst.mockReset();
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
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    const result = await convertToTaskpilotTask(ctx, {
      emailId: "msg-1",
      preview: true,
    });
    const data = expectMcpData(result);
    expect(data).toMatchObject({
      alreadyExisted: false,
    });
    expect(data).toHaveProperty("draft");
    // No work-item was created
    expect(prisma.emailTaskLink.upsert).not.toHaveBeenCalled();
  });

  it("commit creates the task and returns identifier", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
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
    const data = expectMcpData(result);
    expect(data).toMatchObject({
      taskpilotIdentifier: "WEB-1",
    });
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

// Owner decision: the caller converts with their own TaskPilot settings, also
// when the token is bound to (or names) a mailbox someone shared with them.
describe("convertToTaskpilotTask from a shared mailbox", () => {
  it("uses the caller's settings, not the mailbox owner's", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    vi.mocked(getTaskpilotConfigForUser).mockClear();

    await convertToTaskpilotTask(
      { ...ctx, userId: "owner", callerUserId: "shared-user" },
      { emailId: "msg-1", preview: true },
    );

    expect(getTaskpilotConfigForUser).toHaveBeenCalledWith("shared-user");
    expect(getTaskpilotConfigForUser).not.toHaveBeenCalledWith("owner");
  });
});

describe("convertToTaskpilotTask with a pinned project", () => {
  it("offers the decider only the pinned project", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    vi.mocked(getTaskpilotConfigForUser).mockResolvedValueOnce({
      apiKey: "tk",
      workspaceSlug: "acme",
      projectId: "p2",
    });
    vi.spyOn(TaskpilotClient.prototype, "listProjects").mockResolvedValue([
      { id: "p1", identifier: "WEB", name: "Web", description: null },
      { id: "p2", identifier: "OPS", name: "Ops", description: null },
    ]);
    const listLabels = vi
      .spyOn(TaskpilotClient.prototype, "listLabels")
      .mockResolvedValue([]);

    await convertToTaskpilotTask(ctx, { emailId: "msg-pin", preview: true });

    const args = vi.mocked(decidePass1).mock.calls.at(-1)?.[0];
    expect(args?.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(Object.keys(args?.labelsByProject ?? {})).toEqual(["p2"]);
    expect(listLabels).toHaveBeenCalledTimes(1);
  });
});
