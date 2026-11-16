import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { convertEmailToTaskpilotTaskDraftAction } from "@/utils/actions/taskpilot";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { decidePass1 } from "@/utils/taskpilot/decide";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

// Run the action body directly; the auth wrapper is not under test.
vi.mock("@/utils/actions/safe-action", () => {
  const chain: any = {
    metadata: () => chain,
    inputSchema: () => chain,
    action: (fn: unknown) => fn,
  };
  return { actionClient: chain, actionClientUser: chain };
});

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    getMessage: vi.fn(async (id: string) => ({
      id,
      threadId: "thr-1",
      headers: { subject: "Hello", from: "x@example.com" },
      textPlain: "body",
      internalDate: String(Date.now()),
    })),
  })),
}));

vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigForUser: vi.fn(),
  getTaskpilotConfigStatus: vi.fn(),
}));

const { clientMock } = vi.hoisted(() => ({
  clientMock: { listProjects: vi.fn(), listLabels: vi.fn() },
}));
vi.mock("@/utils/taskpilot/client", () => ({
  TaskpilotClient: class {
    listProjects = clientMock.listProjects;
    listLabels = clientMock.listLabels;
  },
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
  },
}));

vi.mock("@/utils/taskpilot/decide", () => ({
  decidePass1: vi.fn(async () => ({
    ok: true,
    decision: {
      action: "CREATE",
      draft: {
        projectId: "p2",
        title: "T",
        descriptionHtml: "<p>x</p>",
        priority: "medium",
        labelNames: [],
        targetDate: null,
      },
    },
  })),
}));

const run = convertEmailToTaskpilotTaskDraftAction as unknown as (args: {
  ctx: Record<string, unknown>;
  parsedInput: { messageId: string };
}) => Promise<any>;

const projects = [
  { id: "p1", identifier: "WEB", name: "Web" },
  { id: "p2", identifier: "OPS", name: "Ops" },
];

describe("convertEmailToTaskpilotTaskDraftAction with a pinned project", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailTaskLink.findFirst.mockResolvedValue(null);
    clientMock.listProjects.mockResolvedValue(projects);
    clientMock.listLabels.mockResolvedValue([]);
  });

  const call = () =>
    run({
      ctx: {
        userId: "u1",
        emailAccountId: "a1",
        provider: "google",
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      parsedInput: { messageId: "msg-1" },
    });

  it("offers only the pinned project", async () => {
    vi.mocked(getTaskpilotConfigForUser).mockResolvedValue({
      apiKey: "k",
      workspaceSlug: "ws",
      projectId: "p2",
    });

    const result = await call();

    const args = vi.mocked(decidePass1).mock.calls[0][0];
    expect(args.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(Object.keys(args.labelsByProject)).toEqual(["p2"]);
    expect(result.projects.map((p: { id: string }) => p.id)).toEqual(["p2"]);
    expect(clientMock.listLabels).toHaveBeenCalledTimes(1);
  });

  it("offers every project when none is pinned", async () => {
    vi.mocked(getTaskpilotConfigForUser).mockResolvedValue({
      apiKey: "k",
      workspaceSlug: "ws",
      projectId: null,
    });

    await call();

    expect(
      vi.mocked(decidePass1).mock.calls[0][0].projects.map((p) => p.id),
    ).toEqual(["p1", "p2"]);
  });
});
