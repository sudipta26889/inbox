import { beforeEach, describe, expect, it, vi } from "vitest";

// Shadow mode is read from env when the route module loads.
vi.hoisted(() => {
  process.env.TASKPILOT_DECISIONS_SHADOW = "true";
});

vi.mock("@/utils/prisma", () => ({
  default: {
    emailTaskLink: { findFirst: vi.fn() },
    taskpilotDecision: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
  },
}));
vi.mock("@/utils/taskpilot/config", () => ({
  getTaskpilotConfigStatus: vi.fn(),
  getTaskpilotConfigForUser: vi.fn(),
}));
vi.mock("@/utils/taskpilot/similar", () => ({ findSimilarTasksTopK: vi.fn() }));
vi.mock("@/utils/taskpilot/decide", () => ({
  decidePass1: vi.fn(),
  decidePass2: vi.fn(),
}));
vi.mock("@/utils/taskpilot/hydrate", () => ({ hydrateCandidates: vi.fn() }));
vi.mock("@/utils/taskpilot/service", () => ({ commitTask: vi.fn() }));
vi.mock("@/utils/taskpilot/cache", () => ({
  taskpilotCache: { getProjects: vi.fn(), getLabels: vi.fn() },
}));
vi.mock("@/utils/taskpilot/client", () => ({
  TaskpilotClient: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

import prisma from "@/utils/prisma";
import {
  getTaskpilotConfigForUser,
  getTaskpilotConfigStatus,
} from "@/utils/taskpilot/config";
import { decidePass1 } from "@/utils/taskpilot/decide";
import { hydrateCandidates } from "@/utils/taskpilot/hydrate";
import { maybeRouteToTaskPilot } from "@/utils/taskpilot/route";
import { findSimilarTasksTopK } from "@/utils/taskpilot/similar";

const PIN = "pin-project";

const candidate = (issueId: string, projectId: string) => ({
  projectId,
  taskpilotIssueId: issueId,
  taskpilotIdentifier: `X-${issueId}`,
  workspaceSlug: "ws",
  score: 0.9,
  detail: {},
  recentComments: [],
});

describe("shadow mode with a pinned project", () => {
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
    (decidePass1 as any).mockResolvedValue({
      ok: true,
      decision: { action: "IGNORE", reason: "r" },
      model: "m",
      effort: "low",
      durationMs: 0,
      usage: null,
    });
  });

  it("gives the decider only candidates from the pinned project", async () => {
    (hydrateCandidates as any).mockResolvedValue([
      candidate("in-pin", PIN),
      candidate("elsewhere", "other-project"),
    ]);

    await maybeRouteToTaskPilot({
      userId: "u1",
      emailAccountId: "a1",
      messageId: "m1",
      threadId: "t1",
      deepLink: "https://x",
      email: {
        subject: "s",
        from: "x@y",
        snippet: "snip",
        receivedAt: new Date(),
      },
      canCreate: true,
    });

    const args = (decidePass1 as any).mock.calls[0][0];
    expect(args.candidates.map((c: any) => c.taskpilotIssueId)).toEqual([
      "in-pin",
    ]);
    const update = (prisma.taskpilotDecision.update as any).mock.calls[0][0]
      .data;
    expect(update.status).toBe("SHADOW");
    expect(update.candidateIssueIds).toEqual(["in-pin"]);
  });
});
