import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockEnv, mockRunApprovalLoop } = vi.hoisted(() => ({
  // Credentials present is what arms the gate. The client-visible flag is
  // deliberately false here: enforcement must not depend on it, because it
  // used to, and setting it false silently let every send through unapproved.
  mockEnv: {
    DHARAHIL_BASE_URL: "https://gateway.test" as string | undefined,
    DHARAHIL_API_KEY: "key" as string | undefined,
    NEXT_PUBLIC_DHARAHIL_ENABLED: false,
  },
  mockRunApprovalLoop: vi.fn(),
}));

vi.mock("@/env", () => ({ env: mockEnv }));
// The decision predicates are the real ones: this gate is only as safe as
// they are, so stubbing them would test nothing.
vi.mock("@/utils/dharahil/client", async () => {
  const { DharaHILClient } = await vi.importActual<
    typeof import("@/utils/dharahil/client")
  >("@/utils/dharahil/client");
  const real = new DharaHILClient();
  return {
    dharahilClient: {
      runApprovalLoop: mockRunApprovalLoop,
      shouldProceed: real.shouldProceed.bind(real),
      shouldRevise: real.shouldRevise.bind(real),
      wasDenied: real.wasDenied.bind(real),
    },
  };
});

import prisma from "@/utils/__mocks__/prisma";
import { isExternalDomain, requireSendApproval } from "./send-approval";

const request = {
  operation: "send_email",
  provider: "gmail" as const,
  to: "someone@example.com",
  emailAccountId: "acct-1" as string | undefined,
  subject: "hello",
  bodyText: "body",
};

describe("requireSendApproval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DHARAHIL_BASE_URL = "https://gateway.test";
    mockEnv.DHARAHIL_API_KEY = "key";
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it("resolves when the reviewer approves", async () => {
    await expect(requireSendApproval(request)).resolves.toBeUndefined();
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  // The whole point: a denial must stop the send, not fall through.
  it("throws when the reviewer denies", async () => {
    mockRunApprovalLoop.mockResolvedValue({
      action: "REJECTED",
      reason: "not now",
    });

    await expect(requireSendApproval(request)).rejects.toThrow(
      /denied by human reviewer/,
    );
  });

  it.each(["AUTO_DENIED", "EXECUTED", "SOMETHING_NEW", undefined, "PENDING"])(
    "blocks the send when the decision action is %s",
    async (action) => {
      mockRunApprovalLoop.mockResolvedValue({ action });

      await expect(requireSendApproval(request)).rejects.toThrow();
    },
  );

  it("explains an unrecognised decision", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "EXECUTED" });

    await expect(requireSendApproval(request)).rejects.toThrow(
      "Email not sent: approval returned EXECUTED",
    );
  });

  it("holds an edited card and says card edits are not applied", async () => {
    mockRunApprovalLoop.mockResolvedValue({
      action: "REVISE_REQUESTED",
      edited: true,
    });

    await expect(requireSendApproval(request)).rejects.toThrow(
      "Email not sent: the approval card was edited. Card edits aren't applied yet; change the email in Inbox and resend.",
    );
  });

  it("sends on ALLOW, APPROVED and AUTO_ALLOWED", async () => {
    for (const action of ["ALLOW", "APPROVED", "AUTO_ALLOWED"]) {
      mockRunApprovalLoop.mockResolvedValue({ action });

      await expect(requireSendApproval(request)).resolves.toBeUndefined();
    }
  });

  it("throws when the reviewer asks for revisions", async () => {
    mockRunApprovalLoop.mockResolvedValue({
      action: "REVISE_REQUESTED",
      revise_input: "soften it",
    });

    await expect(requireSendApproval(request)).rejects.toThrow(/revision/i);
  });

  /**
   * Upstream and any self-host that never set up a gateway: no credentials, no
   * gate, sends proceed. This is the ONLY way to be ungated.
   */
  it("is a no-op when no gateway is configured", async () => {
    mockEnv.DHARAHIL_BASE_URL = undefined;
    mockEnv.DHARAHIL_API_KEY = undefined;

    await expect(requireSendApproval(request)).resolves.toBeUndefined();
    expect(mockRunApprovalLoop).not.toHaveBeenCalled();
  });

  /**
   * The regression that matters. Enforcement used to key on
   * NEXT_PUBLIC_DHARAHIL_ENABLED, so flipping one client-visible boolean — or
   * mistyping it in .env — sent every email unapproved, with no error and no
   * log. A configured deployment cannot be disarmed that way.
   */
  it("gates even when the client-side flag is off", async () => {
    mockEnv.NEXT_PUBLIC_DHARAHIL_ENABLED = false;

    await requireSendApproval(request);

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
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

describe("requireSendApproval sender", () => {
  const approvalArgs = () => mockRunApprovalLoop.mock.calls[0][0];

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DHARAHIL_BASE_URL = "https://gateway.test";
    mockEnv.DHARAHIL_API_KEY = "key";
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it("defaults from to the mailbox address and looks it up by id", async () => {
    await requireSendApproval(request);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "acct-1" },
      select: { email: true },
    });
    expect(approvalArgs().toolArgs.from).toBe("me@example.com");
    expect(approvalArgs().toolArgs.mailbox).toBeUndefined();
    expect(approvalArgs().context.metadata.from).toBe("me@example.com");
  });

  it("shows an explicit different sender as from, with the account as mailbox", async () => {
    await requireSendApproval({ ...request, from: "alias@example.com" });

    expect(approvalArgs().toolArgs.from).toBe("alias@example.com");
    expect(approvalArgs().toolArgs.mailbox).toBe("me@example.com");
  });

  it("adds no mailbox when the explicit sender is the same address in another case", async () => {
    await requireSendApproval({ ...request, from: "Me@Example.com" });

    expect(approvalArgs().toolArgs.from).toBe("Me@Example.com");
    expect(approvalArgs().toolArgs.mailbox).toBeUndefined();
  });

  it("treats a display-name sender as the same address", async () => {
    await requireSendApproval({ ...request, from: "Me <me@example.com>" });

    expect(approvalArgs().toolArgs.mailbox).toBeUndefined();
  });

  it("puts from first in toolArgs, in the agreed order", async () => {
    await requireSendApproval({
      ...request,
      from: "alias@example.com",
      cc: "c@example.com",
      bcc: "b@example.com",
    });

    expect(Object.keys(approvalArgs().toolArgs)).toEqual([
      "from",
      "mailbox",
      "to",
      "cc",
      "bcc",
      "subject",
      "body",
      "isReply",
    ]);
  });

  it("names the sender in the context summary", async () => {
    await requireSendApproval(request);

    expect(approvalArgs().context.contextSummary).toBe(
      "send_email from me@example.com to someone@example.com - Subject: hello",
    );
  });

  it("still asks for approval, from unknown, when the mailbox is not found", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    await requireSendApproval(request);

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
    expect(approvalArgs().toolArgs.from).toBe("unknown");
    expect(approvalArgs().context.contextSummary).toContain("from unknown to");
  });

  it("still asks for approval, from unknown, when there is no account id", async () => {
    await requireSendApproval({ ...request, emailAccountId: undefined });

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(approvalArgs().toolArgs.from).toBe("unknown");
  });

  it("still asks for approval when the lookup throws", async () => {
    prisma.emailAccount.findUnique.mockRejectedValue(new Error("db down"));

    await requireSendApproval(request);

    expect(approvalArgs().toolArgs.from).toBe("unknown");
  });

  it("does not touch the database when the gate is not required", async () => {
    mockEnv.DHARAHIL_BASE_URL = undefined;
    mockEnv.DHARAHIL_API_KEY = undefined;

    await requireSendApproval(request);

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
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
