// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "@/components/email-list/types";
import { EmailMessage } from "@/components/email-list/EmailMessage";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccount: undefined,
    emailAccountId: "account-1",
    userEmail: "user@example.com",
  }),
}));
vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/email-list/EmailContents", () => ({
  HtmlEmail: () => null,
  PlainEmail: ({ text }: { text: string }) => <p>{text}</p>,
}));
vi.mock("@/components/email-list/EmailAttachments", () => ({
  EmailAttachments: () => null,
}));
vi.mock("@/components/email-list/EmailDetails", () => ({
  EmailDetails: () => null,
}));
vi.mock("@/utils/actions/generate-reply", () => ({
  generateNudgeReplyAction: vi.fn(),
}));
vi.mock("@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy", () => ({
  ComposeEmailFormLazy: ({
    replyingToEmail,
  }: {
    replyingToEmail?: { to?: string };
  }) => <div data-testid="composer" data-to={replyingToEmail?.to} />,
}));

describe("EmailMessage reply", () => {
  afterEach(cleanup);

  it("addresses the reply to the sender's Reply-To address", () => {
    renderReply({ "reply-to": "Support <session-123@helpdesk.example>" });

    expect(screen.getByTestId("composer").dataset.to).toBe(
      "Support <session-123@helpdesk.example>",
    );
  });

  it("falls back to From without a Reply-To address", () => {
    renderReply({});

    expect(screen.getByTestId("composer").dataset.to).toBe(
      "Support <messages@helpdesk.example>",
    );
  });
});

function renderReply(extraHeaders: Record<string, string>) {
  const message = {
    date: "2026-01-01T00:00:00.000Z",
    headers: {
      date: "2026-01-01T00:00:00.000Z",
      from: "Support <messages@helpdesk.example>",
      subject: "Subject",
      to: "user@example.com",
      ...extraHeaders,
    },
    attachments: [],
    historyId: "history-1",
    id: "message-1",
    inline: [],
    snippet: "Preview",
    subject: "Subject",
    textPlain: "Message body",
    threadId: "thread-1",
  } as ThreadMessage;

  render(
    <EmailMessage
      expanded
      message={message}
      onExpand={vi.fn()}
      onSendSuccess={vi.fn()}
      refetch={vi.fn()}
      showReplyButton
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Reply" }));
}
