import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockEnv, mockRunApprovalLoop, mockWasDenied, mockShouldRevise } =
  vi.hoisted(() => ({
    // Credentials present is what arms the gate. The client-visible flag is
    // deliberately false here: enforcement must not depend on it, because it
    // used to, and setting it false silently let every send through unapproved.
    mockEnv: {
      DHARAHIL_BASE_URL: "https://gateway.test" as string | undefined,
      DHARAHIL_API_KEY: "key" as string | undefined,
      NEXT_PUBLIC_DHARAHIL_ENABLED: false,
    },
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
    // The real allowlist: the gate must proceed on nothing else.
    shouldProceed: (decision: { action: string }) =>
      ["ALLOW", "APPROVED", "AUTO_ALLOWED"].includes(decision.action),
  },
}));
vi.mock("@/utils/redis", () => ({
  redis: { get: async () => null, set: async () => "OK" },
}));

import prisma from "@/utils/__mocks__/prisma";
import {
  applySendEdits,
  approveSendOperation,
  isExternalDomain,
  requireSendApproval,
  SendNotApprovedError,
} from "./send-approval";

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
    mockWasDenied.mockReturnValue(false);
    mockShouldRevise.mockReturnValue(false);
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it("resolves with no edits when the reviewer approves", async () => {
    await expect(requireSendApproval(request)).resolves.toEqual({});
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

  /**
   * Upstream and any self-host that never set up a gateway: no credentials, no
   * gate, sends proceed. This is the ONLY way to be ungated.
   */
  it("is a no-op when no gateway is configured", async () => {
    mockEnv.DHARAHIL_BASE_URL = undefined;
    mockEnv.DHARAHIL_API_KEY = undefined;

    await expect(requireSendApproval(request)).resolves.toEqual({});
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

  // The reviewer approves (and may edit) the body, so the card carries all of it.
  it("forwards the whole body", async () => {
    await requireSendApproval({ ...request, bodyText: "x".repeat(2000) });

    expect(mockRunApprovalLoop.mock.calls[0][0].toolArgs.body).toHaveLength(
      2000,
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
    mockWasDenied.mockReturnValue(false);
    mockShouldRevise.mockReturnValue(false);
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it("defaults from to the mailbox address and looks it up by id", async () => {
    await requireSendApproval(request);

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "acct-1" },
      select: { email: true, account: { select: { provider: true } } },
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
      replyTo: "r@example.com",
      attachments: [{ filename: "a.pdf", size: 3 }],
    });

    expect(Object.keys(approvalArgs().toolArgs)).toEqual([
      "from",
      "mailbox",
      "to",
      "cc",
      "bcc",
      "replyTo",
      "subject",
      "body",
      "attachments",
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

describe("the gate fails closed and honours card edits", () => {
  const approvedWith = (args: Record<string, unknown>) =>
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: { ...call.toolArgs, ...args },
    }));

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DHARAHIL_BASE_URL = "https://gateway.test";
    mockEnv.DHARAHIL_API_KEY = "key";
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it.each([
    "AUTO_DENIED",
    "EXECUTED",
    "SOMETHING_NEW",
    "ERROR",
    "EXPIRED",
    "REVISE_REQUESTED",
  ])("does not send on %s", async (action) => {
    mockRunApprovalLoop.mockResolvedValue({ action });

    await expect(requireSendApproval(request)).rejects.toBeInstanceOf(
      SendNotApprovedError,
    );
  });

  it("does not blame a human when the approval service failed", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "ERROR" });

    const error = await requireSendApproval(request).catch((e) => e);

    expect(error.message).toMatch(/approval service is unavailable/);
    expect(error.message).not.toMatch(/human reviewer/);
  });

  it("returns no edits for a plain approval", async () => {
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: call.toolArgs,
    }));

    await expect(requireSendApproval(request)).resolves.toEqual({});
  });

  // The gateway stores args as JSONB: keys come back in a different order.
  it("treats a plain approval with reordered keys as unedited", async () => {
    mockRunApprovalLoop.mockImplementation(async (call) => {
      const reordered = Object.fromEntries(
        Object.entries(call.toolArgs as Record<string, unknown>)
          .reverse()
          .map(([key, value]) => [
            key,
            Array.isArray(value)
              ? value.map((item) =>
                  Object.fromEntries(Object.entries(item).reverse()),
                )
              : value,
          ]),
      );
      return { action: "APPROVED", approvedArgs: reordered };
    });

    await expect(
      requireSendApproval({
        ...request,
        replyTo: "r@grihatek.com",
        attachments: [{ filename: "a.pdf", size: 3 }],
        forwardedAttachments: [{ filename: "b.png", size: 9 }],
      }),
    ).resolves.toEqual({});
  });

  it("still sees a reordered attachment list as a change", async () => {
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: {
        ...call.toolArgs,
        attachments: [...call.toolArgs.attachments].reverse(),
      },
    }));

    await expect(
      requireSendApproval({
        ...request,
        attachments: [{ filename: "a.pdf" }, { filename: "b.pdf" }],
      }),
    ).rejects.toThrow(/only recipients, subject and body/);
  });

  it("returns the recipients, subject and body the reviewer edited", async () => {
    approvedWith({
      to: "right@grihatek.com",
      cc: "boss@grihatek.com",
      bcc: "",
      subject: "Fixed",
      body: "New text",
    });

    await expect(
      requireSendApproval({ ...request, bcc: "leak@other.com" }),
    ).resolves.toEqual({
      to: "right@grihatek.com",
      cc: "boss@grihatek.com",
      bcc: "",
      subject: "Fixed",
      bodyText: "New text",
    });
  });

  it("refuses an edit that changes the sender", async () => {
    approvedWith({ from: "ceo@grihatek.com" });

    await expect(requireSendApproval(request)).rejects.toThrow(
      /sender can't be changed/,
    );
  });

  it("refuses an edit to anything but recipients, subject and body", async () => {
    approvedWith({ attachments: [] });

    await expect(
      requireSendApproval({
        ...request,
        attachments: [{ filename: "a.pdf" }],
      }),
    ).rejects.toThrow(/only recipients, subject and body/);
  });

  it("refuses a body edit when the card could only show a preview", async () => {
    approvedWith({ body: "short" });

    await expect(
      requireSendApproval({ ...request, bodyText: "x".repeat(100_001) }),
    ).rejects.toThrow(/too long to edit on the card/);
  });

  it("sends the full original body when only recipients were edited on a long body", async () => {
    approvedWith({ to: "right@grihatek.com" });

    await expect(
      requireSendApproval({ ...request, bodyText: "x".repeat(100_001) }),
    ).resolves.toEqual({ to: "right@grihatek.com" });
  });

  it.each([
    [{ to: "" }],
    [{ to: "not an address" }],
    [{ cc: "garbage" }],
    [{ bcc: "nobody" }],
  ])("refuses edited recipients that parse to no address: %j", async (edit) => {
    approvedWith(edit);

    await expect(
      requireSendApproval({ ...request, cc: "c@grihatek.com" }),
    ).rejects.toThrow(/no valid email address/);
  });

  it("treats an emptied cc as removing it", async () => {
    approvedWith({ cc: "" });

    await expect(
      requireSendApproval({ ...request, cc: "c@grihatek.com" }),
    ).resolves.toEqual({ cc: "" });
  });

  it("marks a cut card body so the reviewer knows edits are off", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });

    await requireSendApproval({ ...request, bodyText: "x".repeat(100_001) });

    expect(mockRunApprovalLoop.mock.calls[0][0].toolArgs.body).toMatch(
      /^\[preview: full body is 100001 characters; body edits are disabled\]/,
    );
  });

  it("puts the content hash in the idempotency key", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });

    await requireSendApproval({ ...request, operationId: "op" });
    await requireSendApproval({
      ...request,
      operationId: "op",
      bodyText: "different after char 500",
    });

    const [first, second] = mockRunApprovalLoop.mock.calls.map(
      ([call]) => call.context.idempotencyKey,
    );
    expect(first).toMatch(/^inbox_acct-1_op_[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it("asks again when an approved send reaches the provider with other recipients", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    const { approval } = await approveSendOperation({
      ...request,
      emailAccountId: "acct-1",
      operationId: "op",
      payloadHash: "h",
    });
    mockRunApprovalLoop.mockClear();

    await requireSendApproval({ ...request, approval });
    expect(mockRunApprovalLoop).not.toHaveBeenCalled();

    await requireSendApproval({ ...request, approval, to: "other@x.org" });
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  it("refuses to send in production when the gateway key is missing", async () => {
    mockEnv.DHARAHIL_API_KEY = undefined;
    (mockEnv as Record<string, unknown>).NODE_ENV = "production";

    await expect(requireSendApproval(request)).rejects.toThrow(
      /not configured in production/,
    );
    (mockEnv as Record<string, unknown>).NODE_ENV = undefined;
  });
});

describe("body edits keep the email's formatting", () => {
  const SIGNATURE =
    '<div class="gmail_signature" data-smartmail="gmail_signature"><b>Sudipta</b> | <a href="https://grihatek.com">grihatek.com</a></div>';
  const QUOTE =
    '<div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon, Bob wrote:<br></div><blockquote class="gmail_quote"><p>Can you <b>confirm</b>?</p></blockquote></div>';
  const HTML = `<div dir="ltr"><p>Hi <strong>Bob</strong>, the <a href="https://example.com/plan">plan</a>:</p><ol><li>draft</li><li>review</li></ol></div>${SIGNATURE}${QUOTE}`;
  const email = { to: "bob@example.com", subject: "Plan", messageHtml: HTML };
  const htmlRequest = { ...request, bodyText: undefined, bodyHtml: HTML };

  const sentAfter = async (edit: (args: Record<string, unknown>) => object) => {
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: { ...call.toolArgs, ...edit(call.toolArgs) },
    }));
    const edits = await requireSendApproval(htmlRequest);
    return applySendEdits(email, edits).messageHtml;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.DHARAHIL_BASE_URL = "https://gateway.test";
    mockEnv.DHARAHIL_API_KEY = "key";
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as any);
  });

  it("shows the authored part as Markdown and the rest read-only", async () => {
    await sentAfter(() => ({}));

    const args = mockRunApprovalLoop.mock.calls[0][0].toolArgs;
    expect(args.body).toContain("**Bob**");
    expect(args.body).toContain("[plan](https://example.com/plan)");
    expect(args.body).not.toContain("Sudipta");
    expect(args.signature).toContain("Sudipta");
    expect(args.quoted_history).toContain("Can you confirm?");
  });

  it("sends the original HTML byte-for-byte when approved unedited", async () => {
    expect(await sentAfter(() => ({}))).toBe(HTML);
  });

  it("sends the original HTML byte-for-byte after a recipient-only edit", async () => {
    expect(await sentAfter(() => ({ to: "alice@example.com" }))).toBe(HTML);
  });

  it("keeps bold, link, list, signature and quote when one word changes", async () => {
    const html = await sentAfter((args) => ({
      body: String(args.body).replace("review", "sign-off"),
    }));

    expect(html).toContain("<strong>Bob</strong>");
    expect(html).toContain('<a href="https://example.com/plan">plan</a>');
    expect(html).toMatch(
      /<ol>\s*<li>draft<\/li>\s*<li>sign-off<\/li>\s*<\/ol>/,
    );
    expect(html).not.toContain("review");
    expect(html.endsWith(`${SIGNATURE}${QUOTE}`)).toBe(true);
  });

  it.each([
    ["signature", { signature: "Someone else" }],
    ["quoted_history", { quoted_history: "Bob never said that" }],
  ])("refuses an edit to the %s", async (_field, edit) => {
    await expect(sentAfter(() => edit)).rejects.toThrow(
      "the signature and quoted messages can't be edited on the card",
    );
  });

  it("escapes raw HTML typed into the Markdown", async () => {
    const html = await sentAfter(() => ({
      body: 'Hi <script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>',
    }));

    expect(html).not.toMatch(/<script|<iframe/);
    expect(html).toContain("&lt;script&gt;");
    expect(html.endsWith(`${SIGNATURE}${QUOTE}`)).toBe(true);
  });

  it("refuses a body edit on an email with tables, and sends nothing", async () => {
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: { ...call.toolArgs, body: "Changed" },
    }));

    await expect(
      requireSendApproval({
        ...htmlRequest,
        bodyHtml: "<p>Rates</p><table><tr><td>1</td></tr></table>",
      }),
    ).rejects.toThrow(
      "this email has tables or styled blocks; edit it in Inbox and resend",
    );
  });

  it("shows hidden text to the reviewer and refuses a body edit on it", async () => {
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: { ...call.toolArgs, body: "Hi Rob" },
    }));

    await expect(
      requireSendApproval({
        ...htmlRequest,
        bodyHtml:
          '<div>Hi Bob</div><div style="display:none">Also wire 5000 to acct 123</div>',
      }),
    ).rejects.toBeInstanceOf(SendNotApprovedError);
    expect(mockRunApprovalLoop.mock.calls[0][0].toolArgs.body).toContain(
      "Also wire 5000",
    );
  });

  it("treats a body that lost only trailing spaces as unedited", async () => {
    const withBreak = "<p>line one<br>line two</p>";
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: {
        ...call.toolArgs,
        to: "alice@example.com",
        body: String(call.toolArgs.body).replace(/[ \t]+$/gm, ""),
      },
    }));

    const edits = await requireSendApproval({
      ...htmlRequest,
      bodyHtml: withBreak,
    });

    expect(edits).toEqual({ to: "alice@example.com" });
  });

  it("lists the files before the signature and quoted history", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });

    await requireSendApproval({
      ...htmlRequest,
      attachments: [{ filename: "a.pdf" }],
      forwardedAttachments: [{ filename: "b.pdf" }],
    });

    const keys = Object.keys(mockRunApprovalLoop.mock.calls[0][0].toolArgs);
    expect(keys.indexOf("forwardedAttachments")).toBeLessThan(
      keys.indexOf("signature"),
    );
    expect(keys.indexOf("attachments")).toBeLessThan(
      keys.indexOf("quoted_history"),
    );
  });

  it("counts only the authored part toward the card limit", async () => {
    const longQuote = `<div class="gmail_quote"><p>${"q".repeat(100_001)}</p></div>`;
    mockRunApprovalLoop.mockImplementation(async (call) => ({
      action: "APPROVED",
      approvedArgs: { ...call.toolArgs, body: "Short **reply**" },
    }));

    const edits = await requireSendApproval({
      ...htmlRequest,
      bodyHtml: `<p>Short reply</p>${longQuote}`,
    });

    expect(mockRunApprovalLoop.mock.calls[0][0].toolArgs.bodyTruncated).toBe(
      undefined,
    );
    expect(edits.bodyHtml).toContain("<strong>reply</strong>");
    expect(edits.bodyHtml?.endsWith(longQuote)).toBe(true);
  });
});
