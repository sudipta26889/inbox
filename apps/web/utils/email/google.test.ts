import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailThread } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import { GmailLabel } from "@/utils/gmail/label";
import { GmailProvider } from "./google";

vi.mock("server-only", () => ({}));

const { envMock, gmailMailMock, gmailDraftMock, gmailAttachmentMock } =
  vi.hoisted(() => ({
    envMock: {
      NEXT_PUBLIC_AUTO_DRAFT_DISABLED: false,
      EMAIL_ENCRYPT_SECRET: "test-encrypt-secret",
      EMAIL_ENCRYPT_SALT: "test-encrypt-salt",
    },
    gmailMailMock: {
      draftEmail: vi.fn().mockResolvedValue({ data: { id: "draft-1" } }),
      forwardEmail: vi.fn(),
      replyToEmail: vi.fn(),
      sendEmailWithPlainText: vi.fn(),
      sendEmailWithHtml: vi.fn(),
      createRawMailMessage: vi.fn().mockResolvedValue("raw-message"),
      htmlToMessageText: vi.fn((html: string) => html),
    },
    gmailDraftMock: {
      getDraft: vi.fn(),
      sendDraft: vi.fn(),
      deleteDraft: vi.fn(),
    },
    gmailAttachmentMock: {
      downloadGmailAttachment: vi.fn(),
      getGmailAttachment: vi.fn(),
    },
  }));

vi.mock("@/env", () => ({
  env: envMock,
}));

vi.mock("@/utils/gmail/mail", () => gmailMailMock);
vi.mock("@/utils/gmail/draft", () => gmailDraftMock);
vi.mock("@/utils/gmail/attachment", () => gmailAttachmentMock);

describe("GmailProvider.updateDraft", () => {
  it("carries existing attachments across the rebuilt message", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });
    const provider = new GmailProvider({
      users: { drafts: { update } },
    } as any);

    gmailDraftMock.getDraft.mockResolvedValue({
      ...createParsedMessage({ id: "msg-1", internalDate: "1000" }),
      attachments: [
        {
          attachmentId: "att-1",
          filename: "contract.pdf",
          mimeType: "application/pdf",
          size: 1024,
        },
      ],
    });
    gmailAttachmentMock.downloadGmailAttachment.mockResolvedValue(
      Buffer.from("pdf-bytes"),
    );

    await provider.updateDraft("r-1", { messageHtml: "revised" });

    expect(gmailAttachmentMock.downloadGmailAttachment).toHaveBeenCalledWith(
      "msg-1",
      "att-1",
      expect.anything(),
      expect.anything(),
    );
    const composed = gmailMailMock.createRawMailMessage.mock.calls.at(-1)![0];
    expect(composed.attachments).toEqual([
      {
        filename: "contract.pdf",
        contentType: "application/pdf",
        content: Buffer.from("pdf-bytes"),
      },
    ]);
    // The draft must stay in its thread after the rebuild.
    expect(update.mock.calls[0]![0].requestBody.message.threadId).toBe(
      "thread-1",
    );
  });

  it("keeps the current recipients and subject when only the body changes", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });
    const provider = new GmailProvider({
      users: { drafts: { update } },
    } as any);

    gmailDraftMock.getDraft.mockResolvedValue({
      ...createParsedMessage({ id: "msg-1", internalDate: "1000" }),
      subject: "Original subject",
      headers: {
        subject: "Original subject",
        from: "sender@example.com",
        to: "a@example.com",
        cc: "c@example.com",
        date: "Mon, 01 Jan 2026 00:00:00 +0000",
      },
    });

    await provider.updateDraft("r-1", { messageHtml: "revised" });

    const composed = gmailMailMock.createRawMailMessage.mock.calls.at(-1)![0];
    expect(composed).toMatchObject({
      to: "a@example.com",
      cc: "c@example.com",
      subject: "Original subject",
      messageHtml: "revised",
    });
  });

  it("throws rather than creating a new draft when the id is unknown", async () => {
    const provider = new GmailProvider({
      users: { drafts: { update: vi.fn() } },
    } as any);

    gmailDraftMock.getDraft.mockResolvedValue(null);

    await expect(provider.updateDraft("r-missing", {})).rejects.toThrow(
      "Draft r-missing not found",
    );
  });
});

describe("GmailProvider.getLatestMessageInThread", () => {
  afterEach(() => {
    envMock.NEXT_PUBLIC_AUTO_DRAFT_DISABLED = false;
  });

  it("returns latest non-draft message when newest message is a draft", async () => {
    const provider = new GmailProvider({} as any);

    vi.spyOn(provider, "getThread").mockResolvedValue(
      createThread([
        createParsedMessage({
          id: "non-draft-older",
          internalDate: "1000",
        }),
        createParsedMessage({
          id: "draft-newest",
          internalDate: "3000",
          labelIds: [GmailLabel.DRAFT],
        }),
        createParsedMessage({
          id: "non-draft-newest",
          internalDate: "2000",
        }),
      ]),
    );

    const latest = await provider.getLatestMessageInThread("thread-1");

    expect(latest?.id).toBe("non-draft-newest");
  });

  it("returns null when all thread messages are drafts", async () => {
    const provider = new GmailProvider({} as any);

    vi.spyOn(provider, "getThread").mockResolvedValue(
      createThread([
        createParsedMessage({
          id: "draft-1",
          internalDate: "1000",
          labelIds: [GmailLabel.DRAFT],
        }),
        createParsedMessage({
          id: "draft-2",
          internalDate: "2000",
          labelIds: [GmailLabel.DRAFT],
        }),
      ]),
    );

    const latest = await provider.getLatestMessageInThread("thread-1");

    expect(latest).toBeNull();
  });

  it("no-ops draftEmail when auto-drafting is disabled", async () => {
    envMock.NEXT_PUBLIC_AUTO_DRAFT_DISABLED = true;
    const provider = new GmailProvider({} as any);

    const result = await provider.draftEmail(
      createParsedMessage({
        id: "message-1",
        internalDate: "1000",
      }),
      { content: "Follow up" },
      "user@example.com",
    );

    expect(result).toEqual({ draftId: "" });
    expect(gmailMailMock.draftEmail).not.toHaveBeenCalled();
  });
});

function createThread(messages: ParsedMessage[]): EmailThread {
  return {
    id: "thread-1",
    messages,
    snippet: "snippet",
  };
}

function createParsedMessage({
  id,
  internalDate,
  labelIds,
}: {
  id: string;
  internalDate: string;
  labelIds?: string[];
}): ParsedMessage {
  return {
    id,
    threadId: "thread-1",
    labelIds,
    snippet: "",
    historyId: "history-1",
    inline: [],
    headers: {
      subject: "Subject",
      from: "sender@example.com",
      to: "recipient@example.com",
      date: "Mon, 01 Jan 2026 00:00:00 +0000",
    },
    subject: "Subject",
    date: "Mon, 01 Jan 2026 00:00:00 +0000",
    internalDate,
    textPlain: "",
    textHtml: "",
  };
}
