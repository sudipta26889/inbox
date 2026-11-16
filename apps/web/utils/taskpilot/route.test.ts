import { describe, expect, it, vi, beforeEach } from "vitest";
import { maybeRouteToTaskPilot } from "@/utils/taskpilot/route";

vi.mock("@/utils/prisma", () => {
  const linkFindUnique = vi.fn();
  const linkFindFirst = vi.fn();
  const linkUpsert = vi.fn();
  const decisionCreate = vi.fn();
  const decisionUpdate = vi.fn();
  const decisionFindFirst = vi.fn();
  return {
    default: {
      emailTaskLink: {
        findUnique: linkFindUnique,
        findFirst: linkFindFirst,
        upsert: linkUpsert,
      },
      taskpilotDecision: {
        create: decisionCreate,
        update: decisionUpdate,
        findFirst: decisionFindFirst,
      },
    },
  };
});
vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigStatus: vi.fn().mockResolvedValue({ configured: true }),
  getTaskpilotConfigForUser: vi.fn().mockResolvedValue({
    apiKey: "k",
    workspaceSlug: "ws",
  }),
}));
vi.mock("@/utils/taskpilot/similar", () => ({
  findSimilarTasksTopK: vi.fn(),
}));
vi.mock("@/utils/taskpilot/decide", () => ({
  decidePass1: vi.fn(),
  decidePass2: vi.fn(),
}));
vi.mock("@/utils/taskpilot/hydrate", () => ({
  hydrateCandidates: vi.fn(),
}));
vi.mock("@/utils/taskpilot/cache", () => ({
  taskpilotCache: {
    getProjects: vi.fn().mockResolvedValue([]),
    getLabels: vi.fn().mockResolvedValue([]),
    getStates: vi.fn().mockResolvedValue([]),
    getMembers: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock("@/utils/taskpilot/service", () => ({
  commitTask: vi.fn(),
}));
const { clientMock } = vi.hoisted(() => ({
  clientMock: {
    addComment: vi.fn(),
    moveTask: vi.fn(),
    updateTask: vi.fn(),
    listStates: vi.fn(),
    listMembers: vi.fn(),
  },
}));
vi.mock("@/utils/taskpilot/client", () => ({
  TaskpilotClient: vi.fn().mockImplementation(function () {
    return clientMock;
  }),
}));

import prisma from "@/utils/prisma";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import {
  getTaskpilotConfigStatus,
  getTaskpilotConfigForUser,
} from "@/utils/taskpilot/config";
import { findSimilarTasksTopK } from "@/utils/taskpilot/similar";
import { decidePass1 } from "@/utils/taskpilot/decide";
import { hydrateCandidates } from "@/utils/taskpilot/hydrate";
import { commitTask } from "@/utils/taskpilot/service";

const baseInput = {
  userId: "u1",
  emailAccountId: "a1",
  messageId: "msg-1",
  threadId: "t1",
  deepLink: "https://inbox.example/m/msg-1",
  email: {
    subject: "s",
    from: "x@y",
    snippet: "snip",
    bodyText: "body",
    receivedAt: new Date("2026-06-29T00:00:00Z"),
  },
  canCreate: false,
};

describe("maybeRouteToTaskPilot pre-gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.emailTaskLink.findUnique as any).mockResolvedValue(null);
    (prisma.emailTaskLink.findFirst as any).mockResolvedValue(null);
    (prisma.taskpilotDecision.findFirst as any).mockResolvedValue(null);
    (prisma.taskpilotDecision.create as any).mockResolvedValue({ id: "d1" });
    (prisma.taskpilotDecision.update as any).mockResolvedValue({});
    (findSimilarTasksTopK as any).mockResolvedValue([]);
    // Re-init mocks cleared by vi.clearAllMocks().
    (getTaskpilotConfigStatus as any).mockResolvedValue({ configured: true });
    (getTaskpilotConfigForUser as any).mockResolvedValue({
      apiKey: "k",
      workspaceSlug: "ws",
    });
    (taskpilotCache.getProjects as any).mockResolvedValue([]);
    (taskpilotCache.getLabels as any).mockResolvedValue([]);
    (taskpilotCache.getStates as any).mockResolvedValue([]);
    (taskpilotCache.getMembers as any).mockResolvedValue([]);
  });

  it("short-circuits IGNORED when no threadLink, no similar, no canCreate", async () => {
    await maybeRouteToTaskPilot(baseInput);
    expect(decidePass1).not.toHaveBeenCalled();
    expect(prisma.taskpilotDecision.create).toHaveBeenCalledTimes(1);
    const createdRow = (prisma.taskpilotDecision.create as any).mock.calls[0][0]
      .data;
    expect(createdRow.status).toBe("IGNORED");
    expect(createdRow.preGateInvoked).toBe(false);
  });

  it("invokes Pass 1 when canCreate=true even without candidates", async () => {
    (decidePass1 as any).mockResolvedValue({
      ok: true,
      decision: { action: "IGNORE", reason: "auto" },
      model: "m",
      effort: "low",
      durationMs: 100,
      usage: null,
    });
    (hydrateCandidates as any).mockResolvedValue([]);
    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });
    expect(decidePass1).toHaveBeenCalled();
  });

  it("invokes Pass 1 when there is a thread link", async () => {
    (prisma.emailTaskLink.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        taskpilotIssueId: "iss-1",
        taskpilotIdentifier: "X-1",
        workspaceSlug: "ws",
        projectId: "p",
      });
    (hydrateCandidates as any).mockResolvedValue([
      {
        projectId: "p",
        taskpilotIssueId: "iss-1",
        taskpilotIdentifier: "X-1",
        workspaceSlug: "ws",
        score: null,
        detail: {
          id: "iss-1",
          identifier: "X-1",
          name: "t",
          description_html: "",
          state: { id: "s", name: "n", group: "started" },
          priority: "medium",
          assignees: [],
          labels: [],
        },
        recentComments: [],
      },
    ]);
    (decidePass1 as any).mockResolvedValue({
      ok: true,
      decision: { action: "IGNORE", reason: "no action" },
      model: "m",
      effort: "low",
      durationMs: 0,
      usage: null,
    });
    await maybeRouteToTaskPilot(baseInput);
    expect(decidePass1).toHaveBeenCalled();
  });

  it("bails on existing EmailTaskLink for this messageId", async () => {
    // Route uses findFirst for idempotency check (not findUnique)
    (prisma.emailTaskLink.findFirst as any).mockResolvedValueOnce({
      id: "el-1",
    });
    await maybeRouteToTaskPilot(baseInput);
    expect(decidePass1).not.toHaveBeenCalled();
    expect(prisma.taskpilotDecision.create).not.toHaveBeenCalled();
  });

  it("bails on a fresh RUNNING TaskpilotDecision sentinel", async () => {
    (prisma.taskpilotDecision.findFirst as any).mockResolvedValue({
      status: "RUNNING",
      ranAt: new Date(Date.now() - 5000), // 5s old
    });
    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });
    expect(decidePass1).not.toHaveBeenCalled();
  });

  it("ignores a stale RUNNING sentinel (>60s old) and proceeds", async () => {
    (prisma.taskpilotDecision.findFirst as any).mockResolvedValue({
      status: "RUNNING",
      ranAt: new Date(Date.now() - 120_000), // 2 minutes old
    });
    (decidePass1 as any).mockResolvedValue({
      ok: true,
      decision: { action: "IGNORE", reason: "stale-ok" },
      model: "m",
      effort: "low",
      durationMs: 0,
      usage: null,
    });
    (hydrateCandidates as any).mockResolvedValue([]);
    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });
    expect(decidePass1).toHaveBeenCalled();
  });

  it("never throws on Pass 1 LLM failure; writes LLM_FAILED row", async () => {
    (decidePass1 as any).mockResolvedValue({
      ok: false,
      errorMsg: "timeout",
      model: "m",
      effort: "low",
      durationMs: 30_000,
      usage: null,
    });
    (hydrateCandidates as any).mockResolvedValue([]);
    await expect(
      maybeRouteToTaskPilot({ ...baseInput, canCreate: true }),
    ).resolves.not.toThrow();
    const lastUpdate = (prisma.taskpilotDecision.update as any).mock.calls.at(
      -1,
    )[0].data;
    expect(lastUpdate.status).toBe("LLM_FAILED");
  });
});

describe("maybeRouteToTaskPilot with a pinned project", () => {
  const PIN = "pin-project";
  const OTHER = "other-project";

  const candidate = (issueId: string, projectId: string) => ({
    projectId,
    taskpilotIssueId: issueId,
    taskpilotIdentifier: `X-${issueId}`,
    workspaceSlug: "ws",
    score: 0.9,
    detail: {
      id: issueId,
      identifier: `X-${issueId}`,
      name: "t",
      description_html: "",
      state: { id: "s", name: "n", group: "started" },
      priority: "medium",
      assignees: [],
      labels: [],
    },
    recentComments: [],
  });

  const ignoreDecision = {
    ok: true,
    decision: { action: "IGNORE", reason: "no action" },
    model: "m",
    effort: "low",
    durationMs: 0,
    usage: null,
  };

  const workspaceProjects = [
    { id: PIN, identifier: "PIN", name: "Pinned" },
    { id: OTHER, identifier: "OTH", name: "Other" },
  ];

  const decisionUpdates = () =>
    (prisma.taskpilotDecision.update as any).mock.calls.map(
      (call: any[]) => call[0].data,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.emailTaskLink.findFirst as any).mockResolvedValue(null);
    (prisma.taskpilotDecision.findFirst as any).mockResolvedValue(null);
    (prisma.taskpilotDecision.create as any).mockResolvedValue({ id: "d1" });
    (prisma.taskpilotDecision.update as any).mockResolvedValue({});
    (findSimilarTasksTopK as any).mockResolvedValue([]);
    (getTaskpilotConfigStatus as any).mockResolvedValue({
      configured: true,
      projectId: PIN,
    });
    (getTaskpilotConfigForUser as any).mockResolvedValue({
      apiKey: "k",
      workspaceSlug: "ws",
      projectId: PIN,
    });
    (taskpilotCache.getProjects as any).mockResolvedValue(workspaceProjects);
    (taskpilotCache.getLabels as any).mockResolvedValue([]);
    (decidePass1 as any).mockResolvedValue(ignoreDecision);
  });

  it("gives the decider only candidates from the pinned project", async () => {
    (hydrateCandidates as any).mockResolvedValue([
      candidate("in-pin", PIN),
      candidate("elsewhere", OTHER),
    ]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    const args = (decidePass1 as any).mock.calls[0][0];
    expect(args.candidates.map((c: any) => c.taskpilotIssueId)).toEqual([
      "in-pin",
    ]);
    expect(
      decisionUpdates().find((d: any) => d.candidateIssueIds).candidateIssueIds,
    ).toEqual(["in-pin"]);
  });

  it("offers the decider only the pinned project", async () => {
    (hydrateCandidates as any).mockResolvedValue([]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    const args = (decidePass1 as any).mock.calls[0][0];
    expect(args.projects.map((p: any) => p.id)).toEqual([PIN]);
    expect(Object.keys(args.labelsByProject)).toEqual([PIN]);
  });

  it("rejects a CREATE draft for another project and writes nothing to TaskPilot", async () => {
    (hydrateCandidates as any).mockResolvedValue([]);
    (decidePass1 as any).mockResolvedValue({
      ...ignoreDecision,
      decision: {
        action: "CREATE",
        reason: "r",
        draft: {
          projectId: OTHER,
          title: "t",
          descriptionHtml: "<p>x</p>",
          priority: "medium",
          labelNames: [],
          targetDate: null,
        },
      },
    });

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect(commitTask).not.toHaveBeenCalled();
    expect(decisionUpdates().some((d: any) => d.status === "DOWNGRADED")).toBe(
      true,
    );
  });

  it("accepts a CREATE draft for the pinned project", async () => {
    (hydrateCandidates as any).mockResolvedValue([]);
    (commitTask as any).mockResolvedValue({ taskpilotIssueId: "new-1" });
    (decidePass1 as any).mockResolvedValue({
      ...ignoreDecision,
      decision: {
        action: "CREATE",
        reason: "r",
        draft: {
          projectId: PIN,
          title: "t",
          descriptionHtml: "<p>x</p>",
          priority: "medium",
          labelNames: [],
          targetDate: null,
        },
      },
    });

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect(commitTask).toHaveBeenCalledTimes(1);
  });

  it("records an error and does nothing when the pin is not in the workspace", async () => {
    (taskpilotCache.getProjects as any).mockResolvedValue([
      { id: OTHER, identifier: "OTH", name: "Other" },
    ]);
    (hydrateCandidates as any).mockResolvedValue([]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect(decidePass1).not.toHaveBeenCalled();
    expect(commitTask).not.toHaveBeenCalled();
    expect(hydrateCandidates).not.toHaveBeenCalled();
    expect(decisionUpdates()).toContainEqual({
      status: "TASKPILOT_FAILED",
      errorMsg: "pinned TaskPilot project not found in workspace",
    });
    expect(
      errorLog.mock.calls.map((call) => String(call[0])).join("\n"),
    ).toContain("pinned TaskPilot project not found in workspace");
  });

  it("checks the pin even when the email cannot create tasks", async () => {
    (taskpilotCache.getProjects as any).mockResolvedValue([]);
    (findSimilarTasksTopK as any).mockResolvedValue([
      { projectId: PIN, taskpilotIssueId: "i", score: 0.9 },
    ]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: false });

    expect(decidePass1).not.toHaveBeenCalled();
  });

  it("searches similar tasks inside the pinned project only", async () => {
    (hydrateCandidates as any).mockResolvedValue([]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect((findSimilarTasksTopK as any).mock.calls[0][4]).toBe(PIN);
  });

  it("ignores a thread link into another project before the pre-gate", async () => {
    (prisma.emailTaskLink.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        taskpilotIssueId: "iss-x",
        taskpilotIdentifier: "OTH-1",
        workspaceSlug: "ws",
        projectId: OTHER,
      });

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: false });

    // With the link ignored, nothing opens the pre-gate.
    expect(decidePass1).not.toHaveBeenCalled();
    const row = (prisma.taskpilotDecision.create as any).mock.calls[0][0].data;
    expect(row.preGateInvoked).toBe(false);
    expect(row.preGateSignals.hasThreadLink).toBe(false);
  });

  it("keeps a thread link into the pinned project", async () => {
    (prisma.emailTaskLink.findFirst as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        taskpilotIssueId: "iss-1",
        taskpilotIdentifier: "PIN-1",
        workspaceSlug: "ws",
        projectId: PIN,
      });
    (hydrateCandidates as any).mockResolvedValue([candidate("iss-1", PIN)]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: false });

    expect(decidePass1).toHaveBeenCalled();
  });

  it("does nothing to TaskPilot when the decider names another project's issue", async () => {
    (hydrateCandidates as any).mockResolvedValue([
      candidate("in-pin", PIN),
      candidate("elsewhere", OTHER),
    ]);
    (decidePass1 as any).mockResolvedValue({
      ...ignoreDecision,
      decision: {
        action: "COMMENT_ON",
        reason: "r",
        targetIssueIds: ["elsewhere"],
        comment: { summary: "s", highlights: [] },
        stateGroup: "completed",
        stateConfidence: "HIGH",
        fieldUpdatesNeeded: true,
      },
    });

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect(clientMock.addComment).not.toHaveBeenCalled();
    expect(clientMock.moveTask).not.toHaveBeenCalled();
    expect(clientMock.updateTask).not.toHaveBeenCalled();
    expect(decisionUpdates().some((d: any) => d.status === "DOWNGRADED")).toBe(
      true,
    );
  });

  it("fetches the workspace projects once", async () => {
    (hydrateCandidates as any).mockResolvedValue([]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    expect(taskpilotCache.getProjects).toHaveBeenCalledTimes(1);
  });

  it("behaves as before with no pin: every project and candidate is kept", async () => {
    (getTaskpilotConfigStatus as any).mockResolvedValue({
      configured: true,
      projectId: null,
    });
    (getTaskpilotConfigForUser as any).mockResolvedValue({
      apiKey: "k",
      workspaceSlug: "ws",
      projectId: null,
    });
    (hydrateCandidates as any).mockResolvedValue([
      candidate("a", PIN),
      candidate("b", OTHER),
    ]);

    await maybeRouteToTaskPilot({ ...baseInput, canCreate: true });

    const args = (decidePass1 as any).mock.calls[0][0];
    expect(args.candidates).toHaveLength(2);
    expect(args.projects.map((p: any) => p.id)).toEqual([PIN, OTHER]);
  });
});
