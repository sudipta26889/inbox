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

describe("dharahilClient.runApprovalLoop — immediate decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function gatewayAnswers(body: Record<string, unknown>) {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => Promise.resolve(body),
    });
  }

  const request = {
    toolName: "send_email",
    toolArgs: { to: "someone@example.com" },
    context: {
      agentId: "test",
      runId: "r1",
      stepId: "s1",
      contextSummary: "test",
      riskLevel: "MEDIUM" as const,
      tags: [],
      idempotencyKey: "k1",
      metadata: {},
    },
  };

  /**
   * Regression. The gateway answers auto-allow policies inline, with an action
   * and no request_id/expires_at. Only DENY was handled; ALLOW fell through to
   * "invalid response", threw, and the fail-safe converted the gateway's ALLOW
   * into a denial — blocking every auto-allowed send in production.
   */
  it("passes through an immediate ALLOW instead of failing closed", async () => {
    gatewayAnswers({ action: "ALLOW", request_id: null, status: "RESOLVED" });

    const decision = await dharahilClient.runApprovalLoop(request);

    expect(decision.action).toBe("ALLOW");
    expect(dharahilClient.shouldProceed(decision)).toBe(true);
  });

  it("still denies on an immediate DENY", async () => {
    gatewayAnswers({ action: "DENY", request_id: null, status: "RESOLVED" });

    const decision = await dharahilClient.runApprovalLoop(request);

    expect(dharahilClient.wasDenied(decision)).toBe(true);
  });

  // A response carrying neither a pollable request nor a decision is genuinely
  // unusable, and must still fail closed.
  it("fails closed when the gateway returns neither request nor action", async () => {
    gatewayAnswers({ status: "OK" });

    const decision = await dharahilClient.runApprovalLoop(request);

    expect(dharahilClient.shouldProceed(decision)).toBe(false);
    expect(dharahilClient.wasDenied(decision)).toBe(true);
  });
});

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

  // A status this code does not know is an error, not a go: status alone decides.
  it("blocks a revision request, carrying the reviewer's note", async () => {
    gatewayReturns({
      status: "RESOLVED",
      last_decision: "revise",
      last_decision_revise_input: "soften the tone",
    });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
    expect(dharahilClient.wasDenied(decision!)).toBe(true);
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

describe("fail-closed decision mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["AUTO_DENIED", { status: "AUTO_DENIED" }],
    ["EXECUTED", { status: "EXECUTED" }],
    ["EXECUTED after an approval", { status: "EXECUTED", last_decision: "approve" }],
    ["an unknown status", { status: "SOMETHING_NEW" }],
    ["a resolved approval", { status: "RESOLVED", last_decision: "approve" }],
    ["an edited approval", { status: "APPROVED", last_decision: "edit" }],
    ["an edit after execution", { status: "EXECUTED", last_decision: "edit" }],
  ])("polled %s does not proceed", async (_name, body) => {
    gatewayReturns(body);

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
  });

  it("a polled response with no status keeps polling", async () => {
    gatewayReturns({ last_decision: "approve" });

    expect(await dharahilClient.fetchDecision("req-1")).toBeNull();
  });

  it("maps statuses: AUTO_DENIED rejects, EXECUTED and unknown are errors", async () => {
    for (const [status, action] of [
      ["AUTO_DENIED", "REJECTED"],
      ["EXECUTED", "ERROR"],
      ["SOMETHING_NEW", "ERROR"],
    ]) {
      gatewayReturns({ status });
      expect((await dharahilClient.fetchDecision("req-1"))?.action).toBe(action);
    }
  });

  it("an edited approval is held as a revision request and marked edited", async () => {
    gatewayReturns({ status: "APPROVED", last_decision: "edit" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("REVISE_REQUESTED");
    expect(decision?.edited).toBe(true);
  });

  it("a plain APPROVED still proceeds", async () => {
    gatewayReturns({ status: "APPROVED", last_decision: "approve" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.shouldProceed(decision!)).toBe(true);
    expect(decision?.edited).toBeUndefined();
  });
});

describe("fail-closed immediate decisions", () => {
  const request = {
    toolName: "send_email",
    toolArgs: {},
    context: {
      agentId: "test",
      runId: "r1",
      contextSummary: "test",
      riskLevel: "MEDIUM" as const,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(["AUTO_DENIED", "EXECUTED", "SOMETHING_NEW"])(
    "an immediate %s does not proceed",
    async (action) => {
      gatewayReturns({ action, request_id: null, status: "RESOLVED" });

      const decision = await dharahilClient.runApprovalLoop(request);

      expect(dharahilClient.shouldProceed(decision)).toBe(false);
      expect(dharahilClient.wasDenied(decision)).toBe(true);
    },
  );

  it.each(["ALLOW", "AUTO_ALLOWED"])("an immediate %s still proceeds", async (action) => {
    gatewayReturns({ action, request_id: null, status: "RESOLVED" });

    const decision = await dharahilClient.runApprovalLoop(request);

    expect(dharahilClient.shouldProceed(decision)).toBe(true);
  });

  it("beforeExecute normalizes an immediate action too", async () => {
    gatewayReturns({ action: "AUTO_DENIED", request_id: null });

    expect((await dharahilClient.beforeExecute(request)).action).toBe("REJECTED");
  });
});
