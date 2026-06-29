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
vi.mock("@/utils/taskpilot/client", () => ({
  TaskpilotClient: vi.fn().mockImplementation(function () {
    return {};
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
