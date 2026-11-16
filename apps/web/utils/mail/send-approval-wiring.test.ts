import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { GmailLabel } from "@/utils/gmail/label";
import {
  forwardEmail as gmailForward,
  replyToEmail as gmailReply,
  sendEmailWithHtml as gmailSend,
  sendEmailWithPlainText as gmailSendText,
} from "@/utils/gmail/mail";
import { sendDraft as gmailSendDraft } from "@/utils/gmail/draft";
import {
  forwardEmail as outlookForward,
  replyToEmail as outlookReply,
  sendEmailWithHtml as outlookSend,
  sendEmailWithPlainText as outlookSendText,
} from "@/utils/outlook/mail";
import { sendDraft as outlookSendDraft } from "@/utils/outlook/draft";
import type { ParsedMessage } from "@/utils/types";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { decide, draftContent } = vi.hoisted(() => ({
  decide: vi.fn(),
  draftContent: {
    to: "to@grihatek.com",
    subject: "Hi",
    text: "Body",
    html: undefined as string | undefined,
  },
}));

vi.mock("@/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/env")>();
  return {
    env: {
      ...original.env,
      DHARAHIL_BASE_URL: "https://gateway.test",
      DHARAHIL_API_KEY: "key",
    },
  };
});
vi.mock("@/utils/redis", () => ({
  redis: { get: async () => null, set: async () => "OK" },
}));
vi.mock("@/utils/dharahil/client", () => ({
  dharahilClient: {
    runApprovalLoop: (call: { toolArgs: Record<string, unknown> }) =>
      decide(call),
    shouldProceed: (decision: { action: string }) =>
      decision.action === "APPROVED",
  },
}));
vi.mock("@/utils/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/mail")>()),
  ensureEmailSendingEnabled: vi.fn(),
}));
vi.mock("@/utils/gmail/retry", () => ({
  withGmailRetry: (fn: () => unknown) => fn(),
  withGmailNonIdempotentWriteRetry: (fn: () => unknown) => fn(),
  extractErrorInfo: () => ({}),
}));
vi.mock("@/utils/outlook/retry", () => ({
  withMicrosoftGraphRetry: (fn: () => unknown) => fn(),
  withMicrosoftGraphWriteRetry: (fn: () => unknown) => fn(),
}));
vi.mock("@/utils/gmail/message", () => ({
  getMessage: vi.fn(),
  parseMessage: vi.fn(() => ({
    id: "m-1",
    threadId: "t-1",
    labelIds: [GmailLabel.DRAFT],
    subject: draftContent.subject,
    textPlain: draftContent.text,
    textHtml: draftContent.html,
    attachments: [],
    headers: {
      from: "me@grihatek.com",
      to: draftContent.to,
      subject: draftContent.subject,
      date: "",
    },
  })),
}));

const logger = createScopedLogger("send-approval-wiring-test");
const EDITS = {
  to: "right@grihatek.com",
  subject: "Fixed subject",
  body: "Edited body text",
};
const approve = () =>
  decide.mockImplementation(async ({ toolArgs }) => ({
    action: "APPROVED",
    approvedArgs: toolArgs,
  }));
const approveWithEdits = () =>
  decide.mockImplementation(async ({ toolArgs }) => ({
    action: "APPROVED",
    approvedArgs: { ...toolArgs, ...EDITS },
  }));
const reject = () => decide.mockResolvedValue({ action: "REJECTED" });

const message = {
  id: "m-1",
  threadId: "t-1",
  snippet: "",
  historyId: "",
  inline: [],
  internalDate: "",
  date: "",
  subject: "Question",
  textPlain: "Original",
  textHtml: "<p>Original</p>",
  attachments: [],
  headers: {
    from: "sender@grihatek.com",
    to: "me@grihatek.com",
    subject: "Question",
    date: "",
    "message-id": "<m-1@x>",
  },
} as unknown as ParsedMessage;

/** Every exported function that puts mail on the wire, with how to call it. */
const gmailSends = {
  sendEmailWithHtml: (gmail: gmail_v1.Gmail) =>
    gmailSend(
      gmail,
      { to: "to@grihatek.com", subject: "Hi", messageHtml: "<p>Hi</p>" },
      logger,
      { emailAccountId: "acct-1" },
    ),
  sendEmailWithPlainText: (gmail: gmail_v1.Gmail) =>
    gmailSendText(
      gmail,
      { to: "to@grihatek.com", subject: "Hi", messageText: "Hi" },
      { emailAccountId: "acct-1" },
    ),
  replyToEmail: (gmail: gmail_v1.Gmail) =>
    gmailReply(gmail, message, "Thanks", undefined, undefined, {
      emailAccountId: "acct-1",
    }),
  forwardEmail: (gmail: gmail_v1.Gmail) =>
    gmailForward(
      gmail,
      message,
      { to: "fwd@grihatek.com" },
      {
        emailAccountId: "acct-1",
      },
    ),
};

const outlookSends = {
  sendEmailWithHtml: (client: OutlookFake) =>
    outlookSend(
      client as never,
      { to: "to@grihatek.com", subject: "Hi", messageHtml: "<p>Hi</p>" },
      logger,
      undefined,
      { emailAccountId: "acct-1" },
    ),
  sendEmailWithPlainText: (client: OutlookFake) =>
    outlookSendText(
      client as never,
      { to: "to@grihatek.com", subject: "Hi", messageText: "Hi" },
      logger,
      { emailAccountId: "acct-1" },
    ),
  replyToEmail: (client: OutlookFake) =>
    outlookReply(client as never, message, "Thanks", logger, undefined, {
      emailAccountId: "acct-1",
    }),
  forwardEmail: (client: OutlookFake) =>
    outlookForward(
      client as never,
      { messageId: "m-1", to: "fwd@grihatek.com" },
      logger,
      { emailAccountId: "acct-1" },
    ),
};

describe("every provider send asks first and sends what was approved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    draftContent.to = "to@grihatek.com";
    draftContent.text = "Body";
    draftContent.html = undefined;
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@grihatek.com",
      account: { provider: "google" },
    } as never);
  });

  describe.each(Object.entries(gmailSends))("gmail %s", (_name, send) => {
    it("sends nothing when the reviewer rejects", async () => {
      reject();
      const gmail = fakeGmail();

      await expect(send(gmail)).rejects.toThrow(/denied|not sent/i);
      expect(gmail.users.messages.send).not.toHaveBeenCalled();
      expect(gmail.users.drafts.send).not.toHaveBeenCalled();
    });

    it("sends the recipients, subject and body edited on the card", async () => {
      approveWithEdits();
      const gmail = fakeGmail();

      await send(gmail);

      const raw = sentRaw(gmail);
      expect(raw).toMatch(/^To: right@grihatek\.com/m);
      expect(raw).toMatch(/^Subject: Fixed subject/m);
      expect(raw).toContain("Edited body text");
    });

    it("refuses an edited recipient that is not an address, never sending to the original", async () => {
      decide.mockImplementation(async ({ toolArgs }) => ({
        action: "APPROVED",
        approvedArgs: { ...toolArgs, to: "not an address" },
      }));
      const gmail = fakeGmail();

      await expect(send(gmail)).rejects.toThrow(/no valid email address/);
      expect(gmail.users.messages.send).not.toHaveBeenCalled();
    });

    it("sends the original when approved unedited", async () => {
      approve();
      const gmail = fakeGmail();

      await send(gmail);

      expect(sentRaw(gmail)).not.toContain("right@grihatek.com");
    });
  });

  describe.each(Object.entries(outlookSends))("outlook %s", (_name, send) => {
    it("sends nothing when the reviewer rejects", async () => {
      reject();
      const client = fakeOutlook();

      await expect(send(client)).rejects.toThrow(/denied|not sent/i);
      expect(client.sent()).toEqual([]);
    });

    it("sends the recipients, subject and body edited on the card", async () => {
      approveWithEdits();
      const client = fakeOutlook();

      await send(client);

      expect(client.sent()).toHaveLength(1);
      const written = JSON.stringify(client.writes());
      expect(written).toContain("right@grihatek.com");
      expect(written).toContain("Fixed subject");
      expect(written).toContain("Edited body text");
    });

    it("refuses an edited recipient that is not an address, never sending to the original", async () => {
      decide.mockImplementation(async ({ toolArgs }) => ({
        action: "APPROVED",
        approvedArgs: { ...toolArgs, to: "not an address" },
      }));
      const client = fakeOutlook();

      await expect(send(client)).rejects.toThrow(/no valid email address/);
      expect(client.sent()).toEqual([]);
    });
  });

  describe("draft sends", () => {
    it("gmail: rejects without sending", async () => {
      reject();
      const gmail = fakeGmail();

      await expect(gmailSendDraft(gmail, "r-1", {})).rejects.toThrow();
      expect(gmail.users.drafts.send).not.toHaveBeenCalled();
    });

    it("gmail: shows an HTML-only draft's text on the card", async () => {
      draftContent.text = "";
      draftContent.html = "<p>Only <b>HTML</b> here</p>";
      approve();

      await gmailSendDraft(fakeGmail(), "r-1", {});

      expect(decide.mock.calls[0][0].toolArgs.body).toContain("Only HTML here");
    });

    it("gmail: writes card edits into the draft, then sends it", async () => {
      approveWithEdits();
      const gmail = fakeGmail();
      const update = vi.fn();

      await gmailSendDraft(gmail, "r-1", {}, update);

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "right@grihatek.com",
          subject: "Fixed subject",
          messageHtml: "<p>Edited body text</p>",
        }),
      );
      expect(gmail.users.drafts.send).toHaveBeenCalledTimes(1);
      expect(
        update.mock.invocationCallOrder[0] <
          vi.mocked(gmail.users.drafts.send).mock.invocationCallOrder[0],
      ).toBe(true);
    });

    // The draft is sent as it is at send time, not as the card showed it.
    it("gmail: refuses a draft that changed while the card was open", async () => {
      decide.mockImplementation(async ({ toolArgs }) => {
        draftContent.to = "someone-else@other.org";
        return { action: "APPROVED", approvedArgs: toolArgs };
      });
      const gmail = fakeGmail();

      await expect(gmailSendDraft(gmail, "r-1", {})).rejects.toThrow(
        /draft changed/,
      );
      expect(gmail.users.drafts.send).not.toHaveBeenCalled();
    });

    it("outlook: refuses a draft that changed while the card was open", async () => {
      let reads = 0;
      const client = fakeOutlook({
        "/me/messages/d-1": {
          get: () => ({
            conversationId: "c-1",
            subject: reads++ === 0 ? "Hi" : "Changed",
            toRecipients: [{ emailAddress: { address: "to@grihatek.com" } }],
            body: { contentType: "text", content: "Body" },
            attachments: [],
          }),
        },
      });
      approve();

      await expect(
        outlookSendDraft({ client: client as never, draftId: "d-1", logger }),
      ).rejects.toThrow(/draft changed/);
      expect(client.sent()).toEqual([]);
    });

    it("outlook: shows the draft's files and cc/bcc on the card", async () => {
      const client = fakeOutlook({
        "/me/messages/d-1": {
          get: () => ({
            conversationId: "c-1",
            subject: "Hi",
            from: { emailAddress: { address: "alias@grihatek.com" } },
            toRecipients: [{ emailAddress: { address: "to@grihatek.com" } }],
            ccRecipients: [
              { emailAddress: { address: "c1@grihatek.com" } },
              { emailAddress: { address: "c2@grihatek.com" } },
            ],
            bccRecipients: [{ emailAddress: { address: "b1@grihatek.com" } }],
            body: { contentType: "text", content: "Body" },
            attachments: [{ name: "invoice.pdf", size: 10 }],
          }),
        },
      });
      approve();

      await outlookSendDraft({
        client: client as never,
        draftId: "d-1",
        logger,
        gate: { emailAccountId: "acct-1" },
      });

      expect(decide.mock.calls[0][0].toolArgs).toMatchObject({
        from: "alias@grihatek.com",
        cc: "c1@grihatek.com, c2@grihatek.com",
        bcc: "b1@grihatek.com",
        attachments: [{ filename: "invoice.pdf", size: 10 }],
      });
      expect(client.sent()).toEqual(["/me/messages/d-1/send"]);
    });
  });
});

/**
 * Nothing outside the four provider modules (and the Resend adapter, which the
 * transactional chokepoint guards) may call a send API. A new send primitive
 * anywhere else must come with its own gate and a change to this list.
 */
describe("send primitives live only behind the gate", () => {
  const SEND_PRIMITIVE =
    /users\.(messages|drafts)\.send\(|api\(\s*[`"'][^`"']*\/(send|sendMail|reply|replyAll|forward)[`"']|emails\.send\(|\.sendMail\(/;
  const ALLOWED = new Set([
    "apps/web/utils/gmail/mail.ts",
    "apps/web/utils/gmail/draft.ts",
    "apps/web/utils/outlook/mail.ts",
    "apps/web/utils/outlook/draft.ts",
    "packages/transactional-email/src/providers/resend.ts",
  ]);

  it("finds no ungated send call in apps/web or packages", () => {
    const root = join(process.cwd(), "..", "..");
    const offenders = [
      ...sourceFiles(join(root, "apps/web")),
      ...sourceFiles(join(root, "packages")),
    ]
      .map((file) => relative(root, file))
      .filter((file) => !ALLOWED.has(file))
      .filter((file) =>
        SEND_PRIMITIVE.test(readFileSync(join(root, file), "utf8")),
      );

    expect(offenders).toEqual([]);
    // Walking the tree is slow on a busy shared disk.
  }, 60_000);
});

type OutlookFake = ReturnType<typeof fakeOutlook>;

function fakeGmail() {
  return {
    users: {
      messages: {
        send: vi.fn().mockResolvedValue({ data: { id: "s-1" } }),
      },
      drafts: {
        get: vi.fn().mockResolvedValue({
          data: { id: "r-1", message: { id: "m-1", threadId: "t-1" } },
        }),
        send: vi
          .fn()
          .mockResolvedValue({ data: { id: "m-1", threadId: "t-1" } }),
      },
    },
  } as unknown as gmail_v1.Gmail & {
    users: {
      messages: { send: ReturnType<typeof vi.fn> };
      drafts: { send: ReturnType<typeof vi.fn> };
    };
  };
}

function sentRaw(gmail: ReturnType<typeof fakeGmail>) {
  const call =
    vi.mocked(gmail.users.messages.send).mock.calls[0] ??
    vi.mocked(gmail.users.drafts.send).mock.calls[0];
  const body = (call[0] as { requestBody: { raw?: string } }).requestBody;
  return Buffer.from(body.raw ?? "", "base64url").toString("utf8");
}

function fakeOutlook(
  overrides: Record<string, Record<string, () => unknown>> = {},
) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const routes: Record<string, Record<string, () => unknown>> = {
    "/me/messages": { post: () => ({ id: "d-1", conversationId: "c-1" }) },
    "/me/messages/m-1": {
      get: () => ({
        id: "m-1",
        conversationId: "c-1",
        subject: "Question",
        body: { content: "Original" },
        from: { emailAddress: { address: "sender@grihatek.com" } },
      }),
    },
    "/me/messages/m-1/attachments": { get: () => ({ value: [] }) },
    "/me/messages/m-1/createReply": {
      post: () => ({ id: "r-1", conversationId: "c-1" }),
    },
    "/me/messages/m-1/createForward": {
      post: () => ({ id: "f-1", conversationId: "c-1" }),
    },
    ...overrides,
  };
  const client = {
    getClient: () => ({
      api: (path: string) => {
        const chain = {
          select: () => chain,
          expand: () => chain,
          header: () => chain,
          get: async () => {
            calls.push({ path, method: "get" });
            return routes[path]?.get?.() ?? {};
          },
          post: async (body: unknown) => {
            calls.push({ path, method: "post", body });
            return routes[path]?.post?.() ?? {};
          },
          patch: async (body: unknown) => {
            calls.push({ path, method: "patch", body });
            return {};
          },
        };
        return chain;
      },
    }),
    sent: () =>
      calls
        .filter((call) => call.method === "post" && /\/send$/.test(call.path))
        .map((call) => call.path),
    writes: () =>
      calls.filter((call) => call.method !== "get").map((call) => call.body),
  };
  return client;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (
      name === "node_modules" ||
      name === ".next" ||
      name === "generated" ||
      name === "__tests__" ||
      name.startsWith(".")
    )
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}
