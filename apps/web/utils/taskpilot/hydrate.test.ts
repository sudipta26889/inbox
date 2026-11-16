import { describe, expect, it, vi } from "vitest";
import { hydrateCandidates } from "@/utils/taskpilot/hydrate";

function makeClient(responses: {
  getTask?: (projectId: string, issueId: string) => any;
  listComments?: (projectId: string, issueId: string, limit: number) => any;
}) {
  return {
    getTask: vi.fn(responses.getTask),
    listComments: vi.fn(responses.listComments),
  } as any;
}

describe("hydrateCandidates", () => {
  it("dedupes a candidate appearing as both thread-link and similar hit", async () => {
    const client = makeClient({
      getTask: () => ({
        id: "iss-1",
        identifier: "X-1",
        name: "t",
        description_html: "",
        state: { id: "s", name: "n", group: "started" },
        priority: "medium",
        assignees: [],
        labels: [],
      }),
      listComments: () => [],
    });
    const out = await hydrateCandidates(
      client,
      [
        {
          taskpilotIssueId: "iss-1",
          taskpilotIdentifier: "X-1",
          workspaceSlug: "ws",
          projectId: "p",
          score: 0.8,
        },
      ],
      {
        taskpilotIssueId: "iss-1",
        taskpilotIdentifier: "X-1",
        workspaceSlug: "ws",
        projectId: "p",
      },
      { maxCandidates: 3, commentLimit: 5 },
    );
    expect(out).toHaveLength(1);
    expect(client.getTask).toHaveBeenCalledTimes(1);
  });

  it("skips a candidate whose getTask throws 404, returns others", async () => {
    const client = makeClient({
      getTask: vi.fn((projectId: string, issueId: string) => {
        if (issueId === "iss-bad") throw new Error("404");
        return {
          id: issueId,
          identifier: issueId,
          name: "t",
          description_html: "",
          state: { id: "s", name: "n", group: "started" },
          priority: "medium",
          assignees: [],
          labels: [],
        };
      }),
      listComments: () => [],
    });
    const out = await hydrateCandidates(
      client,
      [
        {
          taskpilotIssueId: "iss-1",
          taskpilotIdentifier: "X-1",
          workspaceSlug: "ws",
          projectId: "p",
          score: 0.8,
        },
        {
          taskpilotIssueId: "iss-bad",
          taskpilotIdentifier: "X-2",
          workspaceSlug: "ws",
          projectId: "p",
          score: 0.7,
        },
      ],
      null,
      { maxCandidates: 3, commentLimit: 5 },
    );
    expect(out).toHaveLength(1);
    expect(out[0].taskpilotIssueId).toBe("iss-1");
  });

  it("respects maxCandidates", async () => {
    const client = makeClient({
      getTask: (_p: string, issueId: string) => ({
        id: issueId,
        identifier: issueId,
        name: "t",
        description_html: "",
        state: { id: "s", name: "n", group: "started" },
        priority: "medium",
        assignees: [],
        labels: [],
      }),
      listComments: () => [],
    });
    const hits = ["a", "b", "c", "d"].map((id, i) => ({
      taskpilotIssueId: id,
      taskpilotIdentifier: id,
      workspaceSlug: "ws",
      projectId: "p",
      score: 0.9 - i * 0.1,
    }));
    const out = await hydrateCandidates(client, hits, null, {
      maxCandidates: 2,
      commentLimit: 5,
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.taskpilotIssueId)).toEqual(["a", "b"]);
  });
});
