import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, unknown>,
}));
vi.mock("@/env", () => ({ env: mockEnv }));

import { isApprovalGateRequired } from "./required";

function setEnv(values: Record<string, unknown>) {
  for (const key of Object.keys(mockEnv)) delete mockEnv[key];
  Object.assign(mockEnv, values);
}

describe("approval gate requirement", () => {
  it("requires the gate when a gateway is configured", () => {
    setEnv({ DHARAHIL_BASE_URL: "https://gateway", DHARAHIL_API_KEY: "key" });

    expect(isApprovalGateRequired()).toBe(true);
  });

  /**
   * The point of the whole file.
   *
   * Enforcement used to key on NEXT_PUBLIC_DHARAHIL_ENABLED — a client-visible
   * boolean. Setting it false, or typoing it in .env, let every send and every
   * calendar write proceed unapproved with no error and no log. A configured
   * deployment must not be disarmed by a UI flag.
   */
  it("still requires the gate when the client-side flag says otherwise", () => {
    setEnv({
      DHARAHIL_BASE_URL: "https://gateway",
      DHARAHIL_API_KEY: "key",
      NEXT_PUBLIC_DHARAHIL_ENABLED: false,
    });

    expect(isApprovalGateRequired()).toBe(true);
  });

  // Upstream and any self-host that never configured DharaHIL: no gate, as before.
  it("does not require a gate that was never configured", () => {
    setEnv({ NEXT_PUBLIC_DHARAHIL_ENABLED: true });

    expect(isApprovalGateRequired()).toBe(false);
  });

  // Half-configured is not configured: a base URL with no key cannot approve.
  it("does not require the gate on partial configuration", () => {
    setEnv({ DHARAHIL_BASE_URL: "https://gateway" });

    expect(isApprovalGateRequired()).toBe(false);
  });
});
