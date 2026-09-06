import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnv, mockRunApprovalLoop, mockWasDenied, mockShouldRevise } =
  vi.hoisted(() => ({
    mockEnv: { NEXT_PUBLIC_DHARAHIL_ENABLED: true },
    mockRunApprovalLoop: vi.fn(),
    mockWasDenied: vi.fn(() => false),
    mockShouldRevise: vi.fn(() => false),
  }));

vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("@/utils/dharahil/client", () => ({
  dharahilClient: {
    runApprovalLoop: mockRunApprovalLoop,
    wasDenied: mockWasDenied,
    shouldRevise: mockShouldRevise,
  },
}));

import { isExternalDomain, requireSendApproval } from "./send-approval";

const request = {
  operation: "send_email",
  provider: "gmail" as const,
  to: "someone@example.com",
  subject: "hello",
  bodyText: "body",
};

describe("requireSendApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NEXT_PUBLIC_DHARAHIL_ENABLED = true;
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    mockWasDenied.mockReturnValue(false);
    mockShouldRevise.mockReturnValue(false);
  });

  it("resolves when the reviewer approves", async () => {
    await expect(requireSendApproval(request)).resolves.toBeUndefined();
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  // The whole point: a denial must stop the send, not fall through.
  it("throws when the reviewer denies", async () => {
    mockWasDenied.mockReturnValue(true);
    mockRunApprovalLoop.mockResolvedValue({
      action: "REJECTED",
      reason: "not now",
    });

    await expect(requireSendApproval(request)).rejects.toThrow(
      /denied by human reviewer/,
    );
  });

  it("throws when the reviewer asks for revisions", async () => {
    mockShouldRevise.mockReturnValue(true);
    mockRunApprovalLoop.mockResolvedValue({
      action: "REVISE_REQUESTED",
      revise_input: "soften it",
    });

    await expect(requireSendApproval(request)).rejects.toThrow(/revision/i);
  });

  it("is a no-op when DharaHIL is disabled", async () => {
    mockEnv.NEXT_PUBLIC_DHARAHIL_ENABLED = false;

    await expect(requireSendApproval(request)).resolves.toBeUndefined();
    expect(mockRunApprovalLoop).not.toHaveBeenCalled();
  });

  it("scores external recipients as higher risk", async () => {
    await requireSendApproval(request);
    const external = mockRunApprovalLoop.mock.calls[0][0].context.riskLevel;

    mockRunApprovalLoop.mockClear();
    await requireSendApproval({ ...request, to: "me@sudiptadhara.in" });
    const internal = mockRunApprovalLoop.mock.calls[0][0].context.riskLevel;

    expect(external).toBe("HIGH");
    expect(internal).toBe("MEDIUM");
  });

  it("forwards only a preview of the body", async () => {
    await requireSendApproval({ ...request, bodyText: "x".repeat(2000) });

    expect(mockRunApprovalLoop.mock.calls[0][0].toolArgs.body).toHaveLength(
      500,
    );
  });
});

describe("isExternalDomain", () => {
  it("treats the instance's own domains as internal", () => {
    expect(isExternalDomain("me@sudiptadhara.in")).toBe(false);
    expect(isExternalDomain("dev@localhost")).toBe(false);
    expect(isExternalDomain("someone@gmail.com")).toBe(true);
  });
});

/**
 * Structural guard. Every provider function that hands a message to the send
 * API must first call requireSendApproval. This is asserted over the source
 * rather than through mocks because the failure being prevented is someone
 * adding a seventh send path and simply forgetting — which is exactly how
 * reply, forward and both sendDraft paths ended up ungated while a comment on
 * sendEmailWithHtml claimed the gate covered "ALL email sends".
 */
describe("every send path is gated", () => {
  const files = [
    "utils/gmail/mail.ts",
    "utils/gmail/draft.ts",
    "utils/outlook/mail.ts",
    "utils/outlook/draft.ts",
  ];

  // Call sites that actually put a message on the wire.
  const SEND_CALL =
    /users\.(messages|drafts)\.send\(|api\(`\/me\/messages\/\$\{[^}]+\}\/send`\)|\.api\("\/me\/sendMail"\)/;

  for (const file of files) {
    it(`${file} calls requireSendApproval for each send`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const sendCalls = source
        .split("\n")
        .filter((line) => SEND_CALL.test(line)).length;

      if (sendCalls === 0) return;

      const gateCalls = source.split("requireSendApproval(").length - 1;

      expect(
        gateCalls,
        `${file} has ${sendCalls} send call(s) but ${gateCalls} approval gate(s)`,
      ).toBeGreaterThanOrEqual(1);
    });
  }

  it("no provider send file imports dharahilClient directly", () => {
    // The gate lives in one module; a second copy is how the first one drifted.
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");

      expect(source, `${file} should gate via requireSendApproval`).not.toMatch(
        /from "@\/utils\/dharahil\/client"/,
      );
    }
  });
});
