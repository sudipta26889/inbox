import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    DHARAHIL_BASE_URL: "http://gateway.local",
    DHARAHIL_API_KEY: "key",
    DHARAHIL_TENANT_ID: "tenant",
    DHARAHIL_APP_ID: "app",
    DHARAHIL_ENVIRONMENT: "test",
    NEXT_PUBLIC_DHARAHIL_ENABLED: true,
  },
}));

import { dharahilClient } from "./client";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function gatewayReturns(body: Record<string, unknown>) {
  mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
}

describe("dharahilClient.fetchDecision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null while the request is still pending", async () => {
    gatewayReturns({ status: "PENDING" });

    expect(await dharahilClient.fetchDecision("req-1")).toBeNull();
  });

  it("returns null when the gateway call fails", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503 });

    expect(await dharahilClient.fetchDecision("req-1")).toBeNull();
  });

  it("maps an approval to an action that lets work proceed", async () => {
    gatewayReturns({ status: "APPROVED" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision).not.toBeNull();
    expect(dharahilClient.shouldProceed(decision!)).toBe(true);
    expect(dharahilClient.wasDenied(decision!)).toBe(false);
  });

  /**
   * Regression. This returned action "DENIED", which is not in DharaHILAction
   * at all, so wasDenied() was false AND shouldProceed() was false. Both mail
   * send paths check exactly those two, fall through, and send the email the
   * human had just rejected — logging "approved" as they did it.
   */
  it("maps a rejection to an action wasDenied recognises", async () => {
    gatewayReturns({ status: "REJECTED", last_decision_note: "not now" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("REJECTED");
    expect(dharahilClient.wasDenied(decision!)).toBe(true);
    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
    expect(decision?.reason).toBe("not now");
  });

  it("treats a reject decision on a non-rejected status as denied", async () => {
    gatewayReturns({ status: "RESOLVED", last_decision: "reject" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.wasDenied(decision!)).toBe(true);
  });

  it("maps a revision request so callers can branch on it", async () => {
    gatewayReturns({
      status: "RESOLVED",
      last_decision: "revise",
      last_decision_revise_input: "soften the tone",
    });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.shouldRevise(decision!)).toBe(true);
    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
    expect(decision?.revise_input).toBe("soften the tone");
  });

  // Every terminal decision must be actionable: a value that satisfies none of
  // the three predicates silently means "proceed" at every call site.
  it("never returns a decision that satisfies no predicate", async () => {
    for (const body of [
      { status: "APPROVED" },
      { status: "REJECTED" },
      { status: "RESOLVED", last_decision: "approve" },
      { status: "RESOLVED", last_decision: "reject" },
      { status: "RESOLVED", last_decision: "revise" },
      { status: "EXPIRED" },
    ]) {
      gatewayReturns(body);
      const decision = await dharahilClient.fetchDecision("req-1");

      expect(
        dharahilClient.shouldProceed(decision!) ||
          dharahilClient.wasDenied(decision!) ||
          dharahilClient.shouldRevise(decision!),
        `no predicate matched ${JSON.stringify(body)} -> ${decision?.action}`,
      ).toBe(true);
    }
  });
});
