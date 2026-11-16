import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findSimilarTasksTopK } from "@/utils/taskpilot/similar";

describe("findSimilarTasksTopK", () => {
  beforeEach(() => {
    vi.stubEnv("QDRANT_URL", "https://qdrant.example");
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://llm.example");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns up to K hits ordered by score desc, all above threshold", async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            result: [
              {
                score: 0.91,
                payload: {
                  taskpilotIssueId: "a",
                  taskpilotIdentifier: "X-1",
                  workspaceSlug: "ws",
                  projectId: "p",
                },
              },
              {
                score: 0.74,
                payload: {
                  taskpilotIssueId: "b",
                  taskpilotIdentifier: "X-2",
                  workspaceSlug: "ws",
                  projectId: "p",
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const hits = await findSimilarTasksTopK("acct-1", "subject body", 3, 0.5);
    expect(hits.map((h) => h.taskpilotIssueId)).toEqual(["a", "b"]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("returns [] when QDRANT_URL is not configured", async () => {
    vi.unstubAllEnvs();
    const hits = await findSimilarTasksTopK("acct-1", "x", 3, 0.5);
    expect(hits).toEqual([]);
  });
});
