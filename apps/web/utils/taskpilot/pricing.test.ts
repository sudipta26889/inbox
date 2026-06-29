import { describe, expect, it } from "vitest";
import { computeCost, MODEL_PRICES } from "@/utils/taskpilot/pricing";

describe("computeCost", () => {
  it("computes Kimi K2.6 cost from token counts", () => {
    const cost = computeCost({
      model: "kimi-k2.6",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(
      MODEL_PRICES["kimi-k2.6"].inputPerMillion +
        MODEL_PRICES["kimi-k2.6"].outputPerMillion,
      4,
    );
  });

  it("returns 0 for unknown models", () => {
    expect(
      computeCost({
        model: "unknown-model-xyz",
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBe(0);
  });

  it("handles zero tokens", () => {
    expect(
      computeCost({
        model: "kimi-k2.6",
        inputTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0);
  });
});
