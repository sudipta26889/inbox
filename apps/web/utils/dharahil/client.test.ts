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

describe("dharahilClient.beforeExecute — what leaves for the cloud card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: () =>
        Promise.resolve({
          request_id: "req-1",
          expires_at: "2099-01-01T00:00:00Z",
          status: "PENDING",
        }),
    });
  });

  it("redacts every string leaf of tool_args_redacted, tags it, and sends tool_args in full", async () => {
    const toolArgs = {
      from: "me@example.com",
      to: "Jane Doe <jane@acme.com>",
      subject: "Contract terms",
      body: "Here is the draft text",
      attachments: [{ filename: "deal.pdf", size: 3 }],
      nested: { cc: ["a@b.com", "c@d.com"], note: null, flag: true },
      isReply: true,
    };
    const original = structuredClone(toolArgs);

    await dharahilClient.beforeExecute({
      toolName: "send_email",
      toolArgs,
      context: {
        agentId: "test",
        runId: "r1",
        contextSummary: "Approve a reply to Jane Doe",
        riskLevel: "MEDIUM",
        tags: ["email", "gmail", "send_email", "external"],
        idempotencyKey: "k1",
      },
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tool_args).toEqual(original);
    expect(toolArgs).toEqual(original);
    expect(body.tool_args_redacted).toEqual({
      from: "***REDACTED***",
      to: "***REDACTED***",
      subject: "***REDACTED***",
      body: "***REDACTED***",
      attachments: [{ filename: "***REDACTED***", size: "***REDACTED***" }],
      nested: {
        cc: ["***REDACTED***", "***REDACTED***"],
        note: null,
        flag: "***REDACTED***",
      },
      isReply: "***REDACTED***",
    });
    expect(body.tags).toEqual([
      "email",
      "gmail",
      "send_email",
      "external",
      "redacted",
    ]);
    expect(body.context_summary).toBe("Approve a reply to Jane Doe");
  });

  it("adds the redacted tag once", async () => {
    await dharahilClient.beforeExecute({
      toolName: "x",
      toolArgs: {},
      context: {
        agentId: "t",
        runId: "r",
        contextSummary: "s",
        riskLevel: "LOW",
        tags: ["redacted"],
      },
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.tags).toEqual(["redacted"]);
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

  it("blocks a reject decision on a status it does not know", async () => {
    gatewayReturns({ status: "RESOLVED", last_decision: "reject" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.wasDenied(decision!)).toBe(true);
  });

  it("maps a revision request so callers can branch on it", async () => {
    gatewayReturns({
      status: "REVISE_REQUESTED",
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
      { status: "AUTO_DENIED" },
      { status: "EXECUTED" },
      { status: "SOMETHING_NEW" },
      {},
      { status: "APPROVED", last_decision: "edit" },
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

/**
 * The gate proceeds only on an allowlist. Anything the client does not
 * recognise must land on a value that blocks the send, never on itself.
 */
describe("dharahilClient decision mapping fails closed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The reviewer edited the email on the card: the gateway marks it APPROVED
  // and returns the edited args, which are what must be sent.
  it("carries the edited args on an edit", async () => {
    gatewayReturns({
      status: "APPROVED",
      last_decision: "edit",
      approved_args: { to: "fixed@grihatek.com" },
    });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("APPROVED");
    expect(decision?.approvedArgs).toEqual({ to: "fixed@grihatek.com" });
  });

  it("fails an edit that came back without its edited args", async () => {
    gatewayReturns({ status: "APPROVED", last_decision: "edit" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("ERROR");
    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
  });

  it("maps AUTO_DENIED to a rejection", async () => {
    gatewayReturns({ status: "AUTO_DENIED" });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("REJECTED");
  });

  it.each([
    [{ status: "EXECUTED" }],
    [{ status: "SOMETHING_NEW" }],
    [{ status: "RESOLVED" }],
    // Decided on status alone: an approve decision does not rescue it.
    [{ status: "EXECUTED", last_decision: "approve" }],
    [{ status: "RESOLVED", last_decision: "approve" }],
    [{ status: "AUTO_ALLOWED" }],
  ])("maps %j to ERROR, which does not proceed", async (body) => {
    gatewayReturns(body);

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(decision?.action).toBe("ERROR");
    expect(dharahilClient.shouldProceed(decision!)).toBe(false);
  });

  it.each([
    ["AUTO_DENIED", "REJECTED"],
    ["DENY", "REJECTED"],
    ["EXECUTED", "ERROR"],
    ["SOMETHING_NEW", "ERROR"],
    ["ALLOW", "ALLOW"],
    ["AUTO_ALLOWED", "AUTO_ALLOWED"],
  ])("maps an immediate %s to %s", async (action, expected) => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ action, request_id: null }),
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "send_email",
      toolArgs: {},
      context: {
        agentId: "a",
        runId: "r",
        contextSummary: "c",
        riskLevel: "MEDIUM",
      },
    });

    expect(decision.action).toBe(expected);
  });

  it("flags an edit so gates that cannot apply edits refuse it", async () => {
    gatewayReturns({
      status: "APPROVED",
      last_decision: "edit",
      approved_args: { title: "Moved" },
    });

    const decision = await dharahilClient.fetchDecision("req-1");

    expect(dharahilClient.shouldProceed(decision!)).toBe(true);
    expect(dharahilClient.shouldProceedUnedited(decision!)).toBe(false);
  });
});
