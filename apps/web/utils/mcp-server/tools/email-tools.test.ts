import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  createDraft,
  deleteDraft,
  getDraftDetail,
  listDrafts,
  updateDraft,
} from "./email-tools";
import type { McpToolContext } from "./registry";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const providerCreateDraft = vi.fn();
const providerUpdateDraft = vi.fn();
const providerGetDraft = vi.fn();
const providerGetDrafts = vi.fn();
const providerDeleteDraft = vi.fn();
const providerGetDraftStatus = vi.fn();
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    createDraft: providerCreateDraft,
    updateDraft: providerUpdateDraft,
    getDraft: providerGetDraft,
    getDrafts: providerGetDrafts,
    deleteDraft: providerDeleteDraft,
    getDraftStatus: providerGetDraftStatus,
  })),
}));

const context: McpToolContext = {
  clientId: "client-1",
  emailAccountId: "account-default",
  scopes: ["email:write"],
  userId: "user-1",
};

const googleAccount = {
  id: "account-default",
  email: "me@gmail.com",
  account: { provider: "google" },
};

describe("createDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providerCreateDraft.mockResolvedValue({
      id: "draft-1",
      threadId: "thread-1",
    });
    providerGetDraft.mockResolvedValue(null);
    providerGetDrafts.mockResolvedValue([]);
    prisma.emailAccount.findUnique.mockResolvedValue(googleAccount as never);
  });

  it("joins recipients, passes threading through, and links the draft", async () => {
    const result = await createDraft(context, {
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      subject: "Follow up",
      body: "line one\nline two",
      threadId: "thread-1",
      inReplyTo: "msg-9",
    });

    expect(providerCreateDraft).toHaveBeenCalledWith({
      to: "a@example.com, b@example.com",
      cc: "c@example.com",
      bcc: undefined,
      subject: "Follow up",
      messageHtml: "line one<br>line two",
      threadId: "thread-1",
      replyToMessageId: "msg-9",
    });
    expect(result).toEqual({
      success: true,
      draftId: "draft-1",
      threadId: "thread-1",
      webUrl: "https://mail.google.com/mail/u/me@gmail.com/#all/thread-1",
    });
  });

  it("leaves the body alone when isHtml is set", async () => {
    await createDraft(context, {
      to: ["a@example.com"],
      subject: "Hi",
      body: "line one\nline two",
      isHtml: true,
    });

    expect(providerCreateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ messageHtml: "line one\nline two" }),
    );
  });

  it("falls back to the draft id when the provider returns no thread", async () => {
    providerCreateDraft.mockResolvedValue({ id: "draft-2", threadId: "" });

    const result = await createDraft(context, {
      to: ["a@example.com"],
      subject: "Hi",
      body: "hello",
    });

    expect(result.webUrl).toBe(
      "https://mail.google.com/mail/u/me@gmail.com/#all/draft-2",
    );
  });

  it("resolves 'from' to one of the user's own accounts", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "account-work",
    } as never);
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "account-work",
      email: "work@example.com",
      account: { provider: "google" },
    } as never);

    await createDraft(context, {
      to: ["a@example.com"],
      subject: "Hi",
      body: "hello",
      from: "work@example.com",
    });

    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", email: "work@example.com" },
      select: { id: true },
    });
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-work" },
      include: { account: true },
    });
  });

  it("refuses a 'from' that is not a linked account", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);
    prisma.emailAccount.findMany.mockResolvedValue([
      { email: "me@gmail.com" },
    ] as never);

    await expect(
      createDraft(context, {
        to: ["a@example.com"],
        subject: "Hi",
        body: "hello",
        from: "spoof@evil.com",
      }),
    ).rejects.toThrow(/spoof@evil\.com' not found[\s\S]*me@gmail\.com/);
    expect(providerCreateDraft).not.toHaveBeenCalled();
  });

  it("rejects an empty recipient list before touching the provider", async () => {
    await expect(
      createDraft(context, { to: [], subject: "Hi", body: "hello" }),
    ).rejects.toThrow("Missing required parameter 'to'");
    expect(providerCreateDraft).not.toHaveBeenCalled();
  });

  it("decodes base64 attachments into buffers", async () => {
    await createDraft(context, {
      to: ["a@example.com"],
      subject: "Report",
      body: "attached",
      attachments: [
        {
          filename: "q3.txt",
          content: Buffer.from("hello world").toString("base64"),
          contentType: "text/plain",
        },
      ],
    });

    const { attachments } = providerCreateDraft.mock.calls[0]![0];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("q3.txt");
    expect(attachments[0].contentType).toBe("text/plain");
    expect(attachments[0].content.toString()).toBe("hello world");
  });

  it("defaults the content type when the agent omits it", async () => {
    await createDraft(context, {
      to: ["a@example.com"],
      subject: "Report",
      body: "attached",
      attachments: [{ filename: "blob", content: "AAAA" }],
    });

    const { attachments } = providerCreateDraft.mock.calls[0]![0];
    expect(attachments[0].contentType).toBe("application/octet-stream");
  });
});

describe("updateDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(googleAccount as never);
    providerGetDraft.mockResolvedValue({
      id: "msg-1",
      draftId: "draft-1",
      threadId: "thread-1",
    });
  });

  it("only sends the fields the caller supplied", async () => {
    await updateDraft(context, { draftId: "draft-1", body: "revised copy" });

    expect(providerUpdateDraft).toHaveBeenCalledWith("draft-1", {
      subject: undefined,
      messageHtml: "revised copy",
      to: undefined,
      cc: undefined,
      bcc: undefined,
    });
  });

  it("distinguishes an empty body from an omitted one", async () => {
    await updateDraft(context, { draftId: "draft-1", body: "" });

    expect(providerUpdateDraft.mock.calls[0]![1].messageHtml).toBe("");
  });

  it("requires a draftId", async () => {
    await expect(
      updateDraft(context, { draftId: "", body: "x" }),
    ).rejects.toThrow("Missing required parameter 'draftId'");
    expect(providerUpdateDraft).not.toHaveBeenCalled();
  });
});

describe("listDrafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(googleAccount as never);
  });

  it("reports the draft id rather than the message id", async () => {
    providerGetDrafts.mockResolvedValue([
      {
        id: "msg-1",
        draftId: "r-123",
        threadId: "thread-1",
        subject: "Follow up",
        date: "2026-09-01",
        snippet: "hi",
        headers: { to: "a@example.com" },
        attachments: [
          { filename: "q3.pdf", mimeType: "application/pdf", size: 100 },
        ],
      },
    ]);

    const result = await listDrafts(context, {});

    expect(result.count).toBe(1);
    expect(result.drafts[0]).toMatchObject({
      draftId: "r-123",
      threadId: "thread-1",
      subject: "Follow up",
      to: "a@example.com",
      attachments: [
        { filename: "q3.pdf", mimeType: "application/pdf", size: 100 },
      ],
    });
  });

  it("caps maxResults at 50", async () => {
    providerGetDrafts.mockResolvedValue([]);

    await listDrafts(context, { maxResults: 500 });

    expect(providerGetDrafts).toHaveBeenCalledWith({ maxResults: 50 });
  });
});

describe("getDraftDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(googleAccount as never);
  });

  it("distinguishes a draft a human sent from one they binned", async () => {
    providerGetDraft.mockResolvedValue(null);
    providerGetDraftStatus.mockResolvedValue({
      status: "sent",
      messageId: "msg-9",
      threadId: "thread-1",
    });

    const sent = await getDraftDetail(context, { draftId: "r-123" });

    expect(sent).toMatchObject({
      found: false,
      status: "sent",
      messageId: "msg-9",
      webUrl: "https://mail.google.com/mail/u/me@gmail.com/#all/thread-1",
    });

    providerGetDraftStatus.mockResolvedValue({ status: "deleted" });

    const deleted = await getDraftDetail(context, { draftId: "r-123" });

    expect(deleted).toMatchObject({ found: false, status: "deleted" });
    expect(deleted).not.toHaveProperty("messageId", expect.anything());
  });

  it("forwards threadId so Gmail can resolve a removed draft record", async () => {
    providerGetDraft.mockResolvedValue(null);
    providerGetDraftStatus.mockResolvedValue({ status: "unknown" });

    await getDraftDetail(context, { draftId: "r-123", threadId: "thread-1" });

    expect(providerGetDraftStatus).toHaveBeenCalledWith("r-123", "thread-1");
  });

  it("reports status draft while it is still unsent", async () => {
    providerGetDraft.mockResolvedValue({
      id: "msg-1",
      draftId: "r-123",
      threadId: "thread-1",
      subject: "Hi",
      date: "2026-09-01",
      snippet: "",
      headers: { to: "a@example.com" },
      textPlain: "hello",
    });

    const result = await getDraftDetail(context, { draftId: "r-123" });

    expect(result).toMatchObject({ found: true, status: "draft" });
    expect(providerGetDraftStatus).not.toHaveBeenCalled();
  });
});

describe("deleteDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(googleAccount as never);
  });

  it("deletes an existing draft", async () => {
    providerGetDraft.mockResolvedValue({ id: "msg-1", draftId: "r-123" });

    const result = await deleteDraft(context, { draftId: "r-123" });

    expect(providerDeleteDraft).toHaveBeenCalledWith("r-123");
    expect(result.success).toBe(true);
  });

  it("does not call the provider when the draft is already gone", async () => {
    providerGetDraft.mockResolvedValue(null);

    const result = await deleteDraft(context, { draftId: "r-123" });

    expect(providerDeleteDraft).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
