import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendColdEmailNotification as sendViaResend } from "@inboxzero/transactional-email";
import { createScopedLogger } from "@/utils/logger";
import { requireSendApproval } from "@/utils/mail/send-approval";
import { sendColdEmailNotification } from "./send-notification";

vi.mock("@inboxzero/transactional-email", () => ({
  sendColdEmailNotification: vi.fn(),
}));

vi.mock("@/utils/mail/send-approval", () => ({
  requireSendApproval: vi.fn(async () => ({})),
}));

vi.mock("@/env", () => ({
  env: {
    RESEND_API_KEY: "test-key",
    RESEND_FROM_EMAIL: "notifications@example.test",
    NEXT_PUBLIC_BASE_URL: "https://example.test",
  },
}));

describe("sendColdEmailNotification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendViaResend).mockResolvedValue({
      data: { id: "notification_1" },
      error: null,
    });
  });

  it.each([
    ["Hello", "Re: Hello"],
    ["re: Hello", "re: Hello"],
    ["a".repeat(3000), `Re: ${"a".repeat(3000)}`],
  ])("preserves reply formatting and threading case %#", async (originalSubject, subject) => {
    const result = await sendColdEmailNotification({
      senderEmail: "sender@example.test",
      recipientEmail: "recipient@example.test",
      originalSubject,
      originalMessageId: "<original@example.test>",
      emailAccountId: "account",
      logger: createScopedLogger("cold-email-notification-test"),
    });

    expect(result).toEqual({ success: true });
    expect(sendViaResend).toHaveBeenCalledWith(
      expect.objectContaining({
        subject,
        inReplyTo: "<original@example.test>",
        replyTo: "recipient@example.test",
        to: "sender@example.test",
      }),
    );
  });

  // The notice is automated mail to an outside person, so a human approves it.
  it("asks for approval and sends nothing when it is refused", async () => {
    vi.mocked(requireSendApproval).mockRejectedValueOnce(
      new Error("Email sending denied by human reviewer"),
    );

    const result = await sendColdEmailNotification({
      senderEmail: "sender@grihatek.com",
      recipientEmail: "me@grihatek.com",
      originalSubject: "Hello",
      emailAccountId: "account",
      logger: createScopedLogger("cold-email-notification-test"),
    });

    expect(requireSendApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "cold_email_notice",
        emailAccountId: "account",
        to: "sender@grihatek.com",
      }),
    );
    expect(result.success).toBe(false);
    expect(sendViaResend).not.toHaveBeenCalled();
  });

  it("sends to the recipient the reviewer corrected", async () => {
    vi.mocked(requireSendApproval).mockResolvedValueOnce({
      to: "right@grihatek.com",
    });

    await sendColdEmailNotification({
      senderEmail: "sender@grihatek.com",
      recipientEmail: "me@grihatek.com",
      originalSubject: "Hello",
      emailAccountId: "account",
      logger: createScopedLogger("cold-email-notification-test"),
    });

    expect(sendViaResend).toHaveBeenCalledWith(
      expect.objectContaining({ to: "right@grihatek.com" }),
    );
  });
});
