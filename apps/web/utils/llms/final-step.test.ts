import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { finalStepMustAnswer } from "./index";

/**
 * The off-by-one here decides whether the agent can answer at all, so it is
 * worth pinning. Steps are zero-indexed: with maxSteps 10 the model gets steps
 * 0-9, and step 9 is the last one it will ever be asked for. Strip tools a step
 * early and it loses a step of real work; a step late and it never runs.
 */
describe("final step must answer", () => {
  const prepare = finalStepMustAnswer(10);
  const call = (stepNumber: number) =>
    prepare({ stepNumber } as any) as { activeTools?: string[] };

  it("leaves tools available while the agent still has steps", () => {
    expect(call(0).activeTools).toBeUndefined();
    expect(call(8).activeTools).toBeUndefined();
  });

  it("takes the tools away on the last step so the model must write prose", () => {
    expect(call(9).activeTools).toEqual([]);
  });

  it("keeps them away if the loop somehow runs past the budget", () => {
    expect(call(10).activeTools).toEqual([]);
  });

  it("handles a single-step budget, where the only step is the last one", () => {
    const single = finalStepMustAnswer(1);
    expect(
      (single({ stepNumber: 0 } as any) as { activeTools?: string[] })
        .activeTools,
    ).toEqual([]);
  });
});
