import { sendColdEmailNotification as sendColdEmailNotificationViaResend } from "@inboxzero/transactional-email";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { formatReplySubject } from "@/utils/email/subject";
import { requireSendApproval } from "@/utils/mail/send-approval";

const NOTICE_TEXT =
  "Inbox's standard notice: your message was filtered as unsolicited and the recipient may not see it.";

export async function sendColdEmailNotification({
  senderEmail,
  recipientEmail,
  originalSubject,
  originalMessageId,
  emailAccountId,
  operationId,
  logger,
}: {
  senderEmail: string; // The cold emailer we're notifying
  recipientEmail: string; // The user who received the cold email
  originalSubject: string;
  originalMessageId?: string; // Message-ID of the original email for threading
  /** The mailbox the cold email reached; the notice speaks for it. */
  emailAccountId: string;
  operationId?: string;
  logger: Logger;
}): Promise<{ success: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) {
    logger.warn("Resend not configured, skipping cold email notification");
    return { success: false, error: "Resend not configured" };
  }

  logger.trace("Sending cold email notification", { senderEmail });

  try {
    // Automated mail to an outside person: a human approves it first.
    const proposedSubject = formatReplySubject(originalSubject);
    const edits = await requireSendApproval({
      operation: "cold_email_notice",
      emailAccountId,
      operationId,
      to: senderEmail,
      from: env.RESEND_FROM_EMAIL,
      replyTo: recipientEmail,
      subject: proposedSubject,
      bodyText: NOTICE_TEXT,
      isReply: true,
    });
    if (
      edits.bodyText !== undefined ||
      edits.cc !== undefined ||
      edits.bcc !== undefined
    )
      return {
        success: false,
        error:
          "Not sent: the notice is a fixed template, so only its recipient and subject can be edited on the card.",
      };
    const subject = edits.subject ?? proposedSubject;

    const result = await sendColdEmailNotificationViaResend({
      from: env.RESEND_FROM_EMAIL,
      to: edits.to ?? senderEmail,
      replyTo: recipientEmail,
      subject,
      inReplyTo: originalMessageId,
      emailProps: {
        baseUrl: env.NEXT_PUBLIC_BASE_URL,
      },
    });

    logger.info("Cold email notification sent", {
      messageId: result.data?.id,
    });

    return { success: true };
  } catch (error) {
    logger.error("Error sending cold email notification", {
      error,
    });
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
