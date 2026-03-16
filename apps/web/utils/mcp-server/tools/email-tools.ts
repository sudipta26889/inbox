import prisma from "@/utils/prisma";
import { getGmailClient } from "@/utils/gmail/client";
import { createOutlookClient } from "@/utils/outlook/client";
import { isGoogleProvider, isMicrosoftProvider } from "@/utils/email/provider-types";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { sendEmail as gmailSendEmail } from "@/utils/gmail/mail";
import { sendEmail as outlookSendEmail } from "@/utils/outlook/mail";
import { getMessage as getGmailMessage } from "@/utils/gmail/message";
import { getMessage as getOutlookMessage } from "@/utils/outlook/message";

const logger = createScopedLogger("mcp-email-tools");

/**
 * Search emails using Gmail or Outlook API
 */
export async function searchEmails(
  context: McpToolContext,
  params: { query: string; maxResults?: number }
) {
  logger.info("MCP tool: search_emails", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    query: params.query,
  });

  // Get email account with provider info
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: context.emailAccountId },
    include: { account: true },
  });

  if (!emailAccount) {
    throw new Error("Email account not found");
  }

  const maxResults = Math.min(params.maxResults || 10, 50);
  const isGmail = isGoogleProvider(emailAccount.account?.provider);

  if (isGmail) {
    const gmail = await getGmailClient(emailAccount);

    const response = await gmail.users.messages.list({
      userId: "me",
      q: params.query,
      maxResults,
    });

    const messages = response.data.messages || [];

    // Fetch basic details for each message
    const detailedMessages = await Promise.all(
      messages.slice(0, 10).map(async (msg) => {
        try {
          const details = await gmail.users.messages.get({
            userId: "me",
            id: msg.id!,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });

          const headers = details.data.payload?.headers || [];
          const getHeader = (name: string) =>
            headers.find((h) => h.name === name)?.value || "";

          return {
            id: msg.id,
            threadId: msg.threadId,
            from: getHeader("From"),
            to: getHeader("To"),
            subject: getHeader("Subject"),
            date: getHeader("Date"),
            snippet: details.data.snippet || "",
          };
        } catch (error) {
          logger.error("Failed to fetch message details", { error, msgId: msg.id });
          return null;
        }
      })
    );

    return {
      results: detailedMessages.filter((m) => m !== null),
      count: messages.length,
      hasMore: messages.length === maxResults,
    };
  } else {
    // Outlook
    const outlook = await createOutlookClient(emailAccount);

    const response = await outlook.api("/me/messages")
      .search(params.query)
      .top(maxResults)
      .select("id,subject,from,receivedDateTime,bodyPreview")
      .get();

    const messages = response.value || [];

    return {
      results: messages.map((msg: any) => ({
        id: msg.id,
        from: msg.from?.emailAddress?.address || "",
        subject: msg.subject || "",
        date: msg.receivedDateTime || "",
        snippet: msg.bodyPreview || "",
      })),
      count: messages.length,
      hasMore: messages.length === maxResults,
    };
  }
}

/**
 * Get full email details by ID
 */
export async function getEmail(
  context: McpToolContext,
  params: { emailId: string }
) {
  logger.info("MCP tool: get_email", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    emailId: params.emailId,
  });

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: context.emailAccountId },
    include: { account: true },
  });

  if (!emailAccount) {
    throw new Error("Email account not found");
  }

  const isGmail = isGoogleProvider(emailAccount.account?.provider);

  if (isGmail) {
    const gmail = await getGmailClient(emailAccount);
    const message = await getGmailMessage(params.emailId, gmail);

    return {
      id: message.id,
      threadId: message.threadId,
      from: message.headers.from,
      to: message.headers.to,
      cc: message.headers.cc,
      subject: message.headers.subject,
      date: message.headers.date,
      textPlain: message.textPlain || "",
      textHtml: message.textHtml || "",
      snippet: message.snippet || "",
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })) || [],
    };
  } else {
    const outlook = await createOutlookClient(emailAccount);
    const message = await getOutlookMessage(params.emailId, outlook);

    return {
      id: message.id,
      threadId: message.conversationId,
      from: message.headers.from,
      to: message.headers.to,
      cc: message.headers.cc,
      subject: message.headers.subject,
      date: message.headers.date,
      textPlain: message.textPlain || "",
      textHtml: message.textHtml || "",
      snippet: message.snippet || "",
      attachments: message.attachments?.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      })) || [],
    };
  }
}

/**
 * Send a new email
 */
export async function sendEmail(
  context: McpToolContext,
  params: {
    to: string[];
    subject: string;
    body: string;
    cc?: string[];
    bcc?: string[];
  }
) {
  logger.info("MCP tool: send_email", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    to: params.to,
    subject: params.subject,
  });

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: context.emailAccountId },
    include: { account: true },
  });

  if (!emailAccount) {
    throw new Error("Email account not found");
  }

  const isGmail = isGoogleProvider(emailAccount.account?.provider);

  // Convert body to HTML if it's plain text
  const messageHtml = params.body.includes("<")
    ? params.body
    : params.body.replace(/\n/g, "<br>");

  if (isGmail) {
    const gmail = await getGmailClient(emailAccount);

    const result = await gmailSendEmail({
      gmail,
      body: {
        to: params.to.join(", "),
        subject: params.subject,
        messageHtml,
        cc: params.cc?.join(", "),
        bcc: params.bcc?.join(", "),
      },
      emailAccountId: context.emailAccountId,
    });

    return {
      success: true,
      messageId: result.id,
      threadId: result.threadId,
    };
  } else {
    const outlook = await createOutlookClient(emailAccount);

    const result = await outlookSendEmail({
      outlook,
      body: {
        to: params.to.join(", "),
        subject: params.subject,
        messageHtml,
        cc: params.cc?.join(", "),
        bcc: params.bcc?.join(", "),
      },
      emailAccountId: context.emailAccountId,
    });

    return {
      success: true,
      messageId: result.id,
    };
  }
}
