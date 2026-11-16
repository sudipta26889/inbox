import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withinMemoryBudget } from "./chat";

const memory = (content: string, date?: string) => ({ content, date });

describe("memory context budget", () => {
  it("injects everything that fits", () => {
    const lines = withinMemoryBudget([
      memory("prefers digests at 5am", "2026-01-01"),
      memory("uses Bluedart for shipping"),
    ]);

    expect(lines).toEqual([
      "- [2026-01-01] prefers digests at 5am",
      "- uses Bluedart for shipping",
    ]);
  });

  /**
   * Capped by size, not item count: one long memory can crowd out the
   * conversation while twenty short ones cost nothing. Recall degrades with
   * input length at every increment, so unbounded grounding makes the model
   * worse at using the grounding.
   */
  it("drops the oldest when the budget runs out, keeping the newest", () => {
    const big = "x".repeat(3000);
    const lines = withinMemoryBudget([
      memory(`oldest ${big}`),
      memory(`newest ${big}`),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("newest");
  });

  // Newest nearest the question is where they read best.
  it("keeps oldest-first order in what it does inject", () => {
    const lines = withinMemoryBudget([
      memory("first"),
      memory("second"),
      memory("third"),
    ]);

    expect(lines).toEqual(["- first", "- second", "- third"]);
  });

  it("returns nothing when a single memory blows the whole budget", () => {
    expect(withinMemoryBudget([memory("x".repeat(10_000))])).toEqual([]);
  });

  it("handles an empty set", () => {
    expect(withinMemoryBudget([])).toEqual([]);
  });
});
