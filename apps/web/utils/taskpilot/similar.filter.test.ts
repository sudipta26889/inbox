import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    QDRANT_URL: "https://qdrant.example",
    OPENAI_COMPATIBLE_BASE_URL: "https://llm.example",
  },
}));

import { findSimilarTasksTopK } from "@/utils/taskpilot/similar";

describe("findSimilarTasksTopK project filter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const searchFilter = async (projectId?: string | null) => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await findSimilarTasksTopK("acct-1", "text", 3, 0.5, projectId);

    const searchCall = (globalThis.fetch as any).mock.calls[1];
    expect(searchCall[0]).toContain("/points/search");
    return JSON.parse(searchCall[1].body).filter.must;
  };

  it("carries the project id in the Qdrant filter when one is given", async () => {
    expect(await searchFilter("pin-project")).toEqual([
      { key: "emailAccountId", match: { value: "acct-1" } },
      { key: "projectId", match: { value: "pin-project" } },
    ]);
  });

  it.each([
    [undefined],
    [null],
  ])("filters on the account only when the project is %s", async (projectId) => {
    expect(await searchFilter(projectId)).toEqual([
      { key: "emailAccountId", match: { value: "acct-1" } },
    ]);
  });
});
