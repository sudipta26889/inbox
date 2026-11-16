import { beforeEach, describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import { createScopedLogger } from "@/utils/logger";
import { GmailLabel } from "@/utils/gmail/label";
import { sendEmailWithHtml as gmailSend } from "@/utils/gmail/mail";
import { sendDraft as gmailSendDraft } from "@/utils/gmail/draft";
import { sendEmailWithHtml as outlookSend } from "@/utils/outlook/mail";
import { sendDraft as outlookSendDraft } from "@/utils/outlook/draft";
import { requireSendApproval } from "@/utils/mail/send-approval";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/mail/send-approval", () => ({
  requireSendApproval: vi.fn(),
  htmlPreviewText: (html: string) => html,
}));
vi.mock("@/utils/mail", () => ({
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
  parseMessage: vi.fn(() => ({
    id: "m-1",
    threadId: "t-1",
    labelIds: [GmailLabel.DRAFT],
    subject: "Hi",
    textPlain: "Body",
    headers: {
      from: "Alias <alias@example.com>",
      to: "to@example.com",
      cc: "cc@example.com",
      bcc: "bcc@example.com",
      subject: "Hi",
      date: "",
    },
  })),
}));
vi.mock("@/utils/sleep", () => ({ sleep: vi.fn(async () => undefined) }));

const logger = createScopedLogger("send-approval-wiring-test");

describe("the sending mailbox reaches the approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("gmail sendEmailWithHtml passes the account id", async () => {
    const gmail = {
      users: {
        messages: { send: vi.fn().mockResolvedValue({ data: { id: "s-1" } }) },
      },
    } as unknown as gmail_v1.Gmail;

    await gmailSend(
      gmail,
      { to: "to@example.com", subject: "Hi", messageHtml: "<p>Hi</p>" },
      logger,
      { emailAccountId: "acct-1" },
    );

    expect(requireSendApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send_email",
        emailAccountId: "acct-1",
      }),
    );
  });

  it("gmail sendDraft passes the account id and the draft's From, Cc and Bcc", async () => {
    const gmail = {
      users: {
        drafts: {
          get: vi.fn().mockResolvedValue({
            data: { id: "r-1", message: { id: "m-1", threadId: "t-1" } },
          }),
          send: vi
            .fn()
            .mockResolvedValue({ data: { id: "m-1", threadId: "t-1" } }),
        },
      },
    } as unknown as gmail_v1.Gmail;

    await gmailSendDraft(gmail, "r-1", { emailAccountId: "acct-1" });

    expect(requireSendApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send_draft",
        emailAccountId: "acct-1",
        from: "Alias <alias@example.com>",
        cc: "cc@example.com",
        bcc: "bcc@example.com",
      }),
    );
  });

  it("outlook sendEmailWithHtml passes the account id", async () => {
    const client = outlookClient({
      "/me/messages": {
        post: async () => ({ id: "d-1", conversationId: "c-1" }),
      },
      "/me/messages/d-1/send": { post: async () => ({}) },
    });

    await outlookSend(
      client,
      { to: "to@example.com", subject: "Hi", messageHtml: "<p>Hi</p>" },
      logger,
      undefined,
      { emailAccountId: "acct-1" },
    );

    expect(requireSendApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send_email",
        emailAccountId: "acct-1",
      }),
    );
  });

  it("outlook sendDraft passes the account id and the draft's From, Cc and Bcc", async () => {
    const client = outlookClient({
      "/me/messages/d-1": {
        get: async () => ({
          conversationId: "c-1",
          subject: "Hi",
          bodyPreview: "Body",
          from: { emailAddress: { address: "alias@example.com" } },
          toRecipients: [{ emailAddress: { address: "to@example.com" } }],
          ccRecipients: [
            { emailAddress: { address: "c1@example.com" } },
            { emailAddress: { address: "c2@example.com" } },
          ],
          bccRecipients: [{ emailAddress: { address: "b1@example.com" } }],
        }),
      },
      "/me/messages/d-1/send": { post: async () => ({}) },
    });

    await outlookSendDraft({
      client,
      draftId: "d-1",
      logger,
      gate: { emailAccountId: "acct-1" },
    });

    expect(requireSendApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send_draft",
        emailAccountId: "acct-1",
        from: "alias@example.com",
        cc: "c1@example.com, c2@example.com",
        bcc: "b1@example.com",
      }),
    );
  });
});

function outlookClient(routes: Record<string, Record<string, () => unknown>>) {
  return {
    getClient: () => ({
      api: (path: string) => {
        const route = routes[path];
        if (!route) throw new Error(`Unexpected API path: ${path}`);
        return { ...route, select: () => route };
      },
    }),
  } as any;
}
