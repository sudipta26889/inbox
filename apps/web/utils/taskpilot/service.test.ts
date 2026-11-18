import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { TaskpilotServerError } from "@/utils/taskpilot/errors";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { commitTask } from "@/utils/taskpilot/service";

vi.mock("@/utils/prisma");

// Indexing for cross-thread dedupe is fire-and-forget and talks to TaskPilot and
// the embeddings service. It has its own tests; here it must not reach a host.
vi.mock("@/utils/taskpilot/reindex", () => ({
  reindexTask: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigForUser: vi
    .fn()
    .mockResolvedValue({ apiKey: "tk_test", workspaceSlug: "acme" }),
  getTaskpilotClientForUser: vi
    .fn()
    .mockResolvedValue(
      new TaskpilotClient({ apiKey: "tk_test", workspaceSlug: "acme" }),
    ),
}));

// taskpilotCache is a module-level singleton; reset between tests by
// re-importing it lazily isn't necessary because we mock listLabels on the
// client to be a no-op (label resolution always sees an empty array).
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

beforeEach(() => {
  vi.restoreAllMocks();
  prisma.emailTaskLink.findFirst.mockReset();
  prisma.emailTaskLink.upsert.mockReset();
});

describe("commitTask", () => {
  it("creates the work item and persists the link", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-1",
      emailAccountId,
      gmailMessageId: "msg-1",
      threadId: "thread-1",
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "WEB-42",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);

    const createWorkItem = vi
      .spyOn(TaskpilotClient.prototype, "createWorkItem")
      .mockResolvedValue({
        id: "issue-1",
        identifier: "WEB-42",
        sequence_id: 42,
        alreadyExisted: false,
      });
    const addLink = vi
      .spyOn(TaskpilotClient.prototype, "addLink")
      .mockResolvedValue();
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);

    const result = await commitTask({
      userId,
      emailAccountId,
      messageId: "msg-1",
      threadId: "thread-1",
      deepLink: "https://mail.google.com/.../msg-1",
      draft: {
        projectId: "p1",
        title: "Title",
        description_html: '<p>x</p><a href="{{INBOX_LINK}}">Open</a>',
        priority: "medium",
        labelNames: [],
      },
      source: "MANUAL",
    });

    expect(result).toMatchObject({
      taskpilotIdentifier: "WEB-42",
      alreadyExisted: false,
    });
    expect(createWorkItem).toHaveBeenCalledWith(
      "p1",
      expect.objectContaining({
        external_source: "inbox",
        external_id: "msg-1",
        description_html: expect.stringContaining(
          "https://mail.google.com/.../msg-1",
        ),
      }),
    );
    expect(addLink).toHaveBeenCalledWith(
      "p1",
      "issue-1",
      expect.objectContaining({ title: "Inbox thread" }),
    );
    expect(prisma.emailTaskLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          taskpilotIdentifier: "WEB-42",
          source: "MANUAL",
        }),
      }),
    );
  });

  it("short-circuits when a link already exists for this email", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue({
      id: "link-existing",
      emailAccountId,
      gmailMessageId: "msg-existing",
      threadId: null,
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-old",
      taskpilotIdentifier: "WEB-1",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);
    const createWorkItem = vi.spyOn(
      TaskpilotClient.prototype,
      "createWorkItem",
    );
    const result = await commitTask({
      userId,
      emailAccountId,
      messageId: "msg-existing",
      threadId: null,
      deepLink: "https://x",
      draft: {
        projectId: "p1",
        title: "Title",
        description_html: "<p>x</p>",
        priority: "medium",
        labelNames: [],
      },
      source: "MANUAL",
    });
    expect(result).toMatchObject({
      taskpilotIdentifier: "WEB-1",
      alreadyExisted: true,
    });
    expect(createWorkItem).not.toHaveBeenCalled();
  });

  it("treats remote 409 as success and writes the link", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-2",
      emailAccountId,
      gmailMessageId: "msg-409",
      threadId: null,
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-existing",
      taskpilotIdentifier: "(pending)",
      source: "RULE",
      ruleId: null,
      createdAt: new Date(),
    } as never);
    vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
      id: "issue-existing",
      identifier: "",
      sequence_id: 0,
      alreadyExisted: true,
    });
    vi.spyOn(TaskpilotClient.prototype, "addLink").mockResolvedValue();
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);
    const result = await commitTask({
      userId,
      emailAccountId,
      messageId: "msg-409",
      threadId: null,
      deepLink: "https://x",
      draft: {
        projectId: "p1",
        title: "Title",
        description_html: "<p>x</p>",
        priority: "medium",
        labelNames: [],
      },
      source: "RULE",
      ruleId: null,
    });
    expect(result.alreadyExisted).toBe(true);
    expect(prisma.emailTaskLink.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          taskpilotIssueId: "issue-existing",
        }),
      }),
    );
  });

  it("does not roll back when addLink fails", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-3",
      emailAccountId,
      gmailMessageId: "msg-link-fail",
      threadId: null,
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "WEB-42",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);
    vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
      id: "issue-1",
      identifier: "WEB-42",
      sequence_id: 42,
      alreadyExisted: false,
    });
    vi.spyOn(TaskpilotClient.prototype, "addLink").mockRejectedValue(
      new Error("link 500"),
    );
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);
    const result = await commitTask({
      userId,
      emailAccountId,
      messageId: "msg-link-fail",
      threadId: null,
      deepLink: "https://x",
      draft: {
        projectId: "p1",
        title: "Title",
        description_html: "<p>x</p>",
        priority: "medium",
        labelNames: [],
      },
      source: "MANUAL",
    });
    expect(result.taskpilotIdentifier).toBe("WEB-42");
    // Link was still written despite addLink failing
    expect(prisma.emailTaskLink.upsert).toHaveBeenCalled();
  });

  it("logs a failed addLink at error level, with the status when the error has one", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "link-4",
      emailAccountId,
      gmailMessageId: "msg-link-log",
      threadId: null,
      workspaceSlug: "acme",
      projectId: "p1",
      taskpilotIssueId: "issue-1",
      taskpilotIdentifier: "WEB-42",
      source: "MANUAL",
      ruleId: null,
      createdAt: new Date(),
    } as never);
    vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
      id: "issue-1",
      identifier: "WEB-42",
      sequence_id: 42,
      alreadyExisted: false,
    });
    vi.spyOn(TaskpilotClient.prototype, "addLink").mockRejectedValue(
      new TaskpilotServerError(502, "bad gateway"),
    );
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await commitTask({
      userId,
      emailAccountId,
      messageId: "msg-link-log",
      threadId: null,
      deepLink: "https://x",
      draft: {
        projectId: "p1",
        title: "Title",
        description_html: "<p>x</p>",
        priority: "medium",
        labelNames: [],
      },
      source: "MANUAL",
    });

    expect(result.taskpilotIdentifier).toBe("WEB-42");
    const logged = errorLog.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("addLink failed");
    expect(logged).toContain('"status": 502');
    expect(
      warnLog.mock.calls.map((call) => String(call[0])).join("\n"),
    ).not.toContain("addLink failed");
  });
});

describe("commitTask with a pinned project", () => {
  const input = (projectId: string) => ({
    userId,
    emailAccountId,
    messageId: "msg-pin",
    threadId: null,
    deepLink: "https://x",
    draft: {
      projectId,
      title: "Title",
      description_html: "<p>x</p>",
      priority: "medium" as const,
      labelNames: [],
    },
    source: "MANUAL" as const,
  });

  it("refuses a draft for another project before writing anything", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    vi.mocked(getTaskpilotConfigForUser).mockResolvedValueOnce({
      apiKey: "tk_test",
      workspaceSlug: "acme",
      projectId: "pin",
    });
    const createWorkItem = vi.spyOn(
      TaskpilotClient.prototype,
      "createWorkItem",
    );

    await expect(commitTask(input("other"))).rejects.toThrow(
      /limited to project pin.*other/,
    );
    expect(createWorkItem).not.toHaveBeenCalled();
    expect(prisma.emailTaskLink.upsert).not.toHaveBeenCalled();
  });

  it("allows a draft for the pinned project", async () => {
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    prisma.emailTaskLink.upsert.mockResolvedValue({
      id: "l",
      taskpilotIdentifier: "WEB-1",
      taskpilotIssueId: "issue-1",
      workspaceSlug: "acme",
    } as never);
    vi.mocked(getTaskpilotConfigForUser).mockResolvedValueOnce({
      apiKey: "tk_test",
      workspaceSlug: "acme",
      projectId: "pin",
    });
    vi.spyOn(TaskpilotClient.prototype, "createWorkItem").mockResolvedValue({
      id: "issue-1",
      identifier: "WEB-1",
      sequence_id: 1,
      alreadyExisted: false,
    });
    vi.spyOn(TaskpilotClient.prototype, "addLink").mockResolvedValue();
    vi.spyOn(TaskpilotClient.prototype, "listLabels").mockResolvedValue([]);

    const result = await commitTask(input("pin"));

    expect(result.taskpilotIssueId).toBe("issue-1");
  });
});
