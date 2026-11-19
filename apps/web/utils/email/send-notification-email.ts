import { createHash } from "node:crypto";
import { env } from "@/env";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import {
  applySendEdits,
  approveSendOperation,
} from "@/utils/mail/send-approval";

export async function sendNotificationEmail({
  emailAccountId,
  userEmail,
  provider,
  subject,
  sendViaResend,
  renderHtml,
  logger,
  operationId,
  beforeSend,
}: {
  emailAccountId: string;
  userEmail: string;
  provider: string;
  subject: string;
  sendViaResend: () => Promise<unknown>;
  renderHtml: () => Promise<string>;
  logger: Logger;
  /** Stable id: asks for approval once, then re-checks `beforeSend`, then sends. */
  operationId?: string;
  /** Runs after approval and before the send; throw to abandon the send. */
  beforeSend?: () => Promise<void>;
}): Promise<void> {
  if (env.RESEND_API_KEY) {
    try {
      await sendViaResend();
      logger.info("Sent notification email via Resend");
      return;
    } catch (error) {
      logger.error(
        "Failed to send notification email via Resend, falling back to self-send",
        { error },
      );
    }
  }

  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  const messageHtml = await renderHtml();

  if (operationId) {
    const approved = await approveSendOperation({
      operation: "send_email",
      provider: provider === "google" ? "gmail" : "outlook",
      emailAccountId,
      operationId,
      payloadHash: createHash("sha256")
        .update(JSON.stringify({ to: userEmail, subject, html: messageHtml }))
        .digest("hex"),
      to: userEmail,
      subject,
      bodyHtml: messageHtml,
    });
    await beforeSend?.();
    await emailProvider.sendEmailWithHtml(
      applySendEdits({ to: userEmail, subject, messageHtml }, approved.edits),
      { approval: approved.approval },
    );
  } else {
    await emailProvider.sendEmailWithHtml({
      to: userEmail,
      subject,
      messageHtml,
    });
  }

  logger.info("Sent notification email via the user's own mailbox");
}
