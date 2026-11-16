import { describe, expect, it, vi } from "vitest";

// Uses the real env schema on purpose. t3-env drops undeclared keys, so if
// the DHARAHIL_* keys go missing from env.ts the calendar and send gates turn
// off silently in production while every mocked-env test stays green.
vi.hoisted(() => {
  process.env.DHARAHIL_BASE_URL = "https://gateway.test";
  process.env.DHARAHIL_API_KEY = "test-key";
});
vi.mock("server-only", () => ({}));

import { env } from "@/env";
import { isApprovalGateRequired } from "@/utils/dharahil/required";

describe("DharaHIL gate against the real env schema", () => {
  it("declares the gateway keys, so a configured deployment arms the gate", () => {
    expect(env).toMatchObject({
      DHARAHIL_BASE_URL: "https://gateway.test",
      DHARAHIL_API_KEY: "test-key",
    });
    expect(isApprovalGateRequired()).toBe(true);
  });
});
