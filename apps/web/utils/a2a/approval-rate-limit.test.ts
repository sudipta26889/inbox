import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RATE_LIMITS } from "./rate-limit";

/**
 * The scarce resource behind an approval is a person's attention.
 *
 * Approval-requiring tasks used to sit under the generic task-creation budget,
 * which allows 500 an hour. A peer could raise hundreds of prompts until the
 * approver stopped reading them and started waving them through — the gate
 * still holding on paper while failing completely in practice.
 */
describe("approval rate limits", () => {
  it("budgets approvals far more tightly than ordinary task creation", () => {
    expect(RATE_LIMITS.APPROVAL_PER_HOUR).toBeLessThan(
      RATE_LIMITS.TASK_CREATE_PER_HOUR,
    );
    expect(RATE_LIMITS.APPROVAL_PER_MINUTE).toBeLessThan(
      RATE_LIMITS.TASK_CREATE_PER_MINUTE,
    );
  });

  /**
   * A number a person could actually review. If this ever has to rise past what
   * someone can read in an hour, the answer is batching or delegation, not a
   * bigger budget.
   */
  it("keeps the hourly budget within human reach", () => {
    expect(RATE_LIMITS.APPROVAL_PER_HOUR).toBeLessThanOrEqual(30);
  });

  it("still allows a normal burst, like scheduling a morning of meetings", () => {
    expect(RATE_LIMITS.APPROVAL_PER_MINUTE).toBeGreaterThanOrEqual(3);
  });
});
