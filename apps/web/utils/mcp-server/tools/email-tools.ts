import prisma from "@/utils/prisma";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { createOutlookClient } from "@/utils/outlook/client";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { sendEmailWithHtml as gmailSendEmail } from "@/utils/gmail/mail";
import { sendEmailWithHtml as outlookSendEmail } from "@/utils/outlook/mail";
import {
  getMessage as getGmailMessage,
  parseMessage,
} from "@/utils/gmail/message";
import { getMessage as getOutlookMessage } from "@/utils/outlook/message";
import { extractEmailId, parseGmailUrl } from "./url-parser";
import { getThread } from "@/utils/gmail/thread";
import {
  downloadAndParseAttachments,
  type GmailAttachment,
} from "@/utils/gmail/attachment";

const logger = createScopedLogger("mcp-email-tools");

/**
 * Decode HTML entities in a string
 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
}

/**
 * Search emails using Gmail or Outlook API
 */
export async function searchEmails(
  context: McpToolContext,
  params: { query: string; maxResults?: number },
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
    const gmail = await getGmailClientWithRefresh({
      accessToken: emailAccount.account?.access_token,
      refreshToken: emailAccount.account?.refresh_token,
      expiresAt: emailAccount.account?.expires_at
        ? new Date(emailAccount.account.expires_at).getTime()
        : null,
      emailAccountId: emailAccount.id,
      logger,
    });

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
            snippet: decodeHtmlEntities(details.data.snippet || ""),
          };
        } catch (error) {
          logger.error("Failed to fetch message details", {
            error,
            msgId: msg.id,
          });
          return null;
        }
      }),
    );

    return {
      results: detailedMessages.filter((m) => m !== null),
      count: messages.length,
      hasMore: messages.length === maxResults,
    };
  } else {
    // Outlook
    const outlook = createOutlookClient(
      emailAccount.account.access_token!,
      logger,
    );

    const response = await outlook
      .getClient()
      .api("/me/messages")
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
        snippet: decodeHtmlEntities(msg.bodyPreview || ""),
      })),
      count: messages.length,
      hasMore: messages.length === maxResults,
    };
  }
}

/**
 * Search emails across multiple accounts or a specific account
 */
export async function searchEmailsMultiAccount(
  context: McpToolContext,
  params: { query: string; maxResults?: number; emailAccountId?: string },
) {
  logger.info("MCP tool: search_emails_multi_account", {
    userId: context.userId,
    query: params.query,
    emailAccountId: params.emailAccountId,
  });

  // Get email accounts - either specific one or all
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      userId: context.userId,
      ...(params.emailAccountId ? { id: params.emailAccountId } : {}),
    },
    include: { account: true },
  });

  if (emailAccounts.length === 0) {
    return {
      results: [],
      accountsSearched: 0,
      totalCount: 0,
      message: params.emailAccountId
        ? `Email account not found or not linked to your user. Account ID: ${params.emailAccountId}`
        : "No email accounts configured",
    };
  }

  const maxResults = Math.min(params.maxResults || 10, 50);

  // Search each account and combine results
  const searchResults = await Promise.all(
    emailAccounts.map(async (emailAccount) => {
      try {
        const accountContext = {
          ...context,
          emailAccountId: emailAccount.id,
        };
        const results = await searchEmails(accountContext, {
          query: params.query,
          maxResults,
        });

        return {
          accountId: emailAccount.id,
          accountEmail: emailAccount.email,
          provider: emailAccount.account?.provider || "unknown",
          ...results,
        };
      } catch (error) {
        logger.error("Failed to search account", {
          error,
          accountEmail: emailAccount.email,
        });
        return {
          accountId: emailAccount.id,
          accountEmail: emailAccount.email,
          provider: emailAccount.account?.provider || "unknown",
          results: [],
          count: 0,
          hasMore: false,
          error: "Failed to search this account",
        };
      }
    }),
  );

  // Flatten and combine all results
  const allResults = searchResults.flatMap((result) =>
    result.results.map((email: any) => ({
      ...email,
      accountId: result.accountId,
      accountEmail: result.accountEmail,
      provider: result.provider,
    })),
  );

  return {
    results: allResults,
    accountsSearched: emailAccounts.length,
    totalCount: allResults.length,
    byAccount: searchResults.map((r) => ({
      accountId: r.accountId,
      accountEmail: r.accountEmail,
      provider: r.provider,
      count: r.count,
      hasMore: r.hasMore,
      error: r.error,
    })),
  };
}

/**
 * Get full email details by ID
 */
export async function getEmail(
  context: McpToolContext,
  params: { emailId: string; emailAccountId?: string },
) {
  // Check if this is a Gmail search URL - automatically search instead
  if (
    params.emailId.includes("mail.google.com") &&
    params.emailId.includes("#search/")
  ) {
    // Extract search query from URL
    const searchMatch = params.emailId.match(/#search\/([^/]+)\//);
    const searchQuery = searchMatch?.[1]?.replace(/\+/g, " ") || "";

    if (!searchQuery) {
      throw new Error(
        `Unable to extract search query from Gmail URL: ${params.emailId}`,
      );
    }

    // Automatically search for the emails
    logger.info("Gmail search URL detected, searching for emails", {
      query: searchQuery,
      originalUrl: params.emailId,
    });

    try {
      const searchResults = await searchEmailsMultiAccount(context, {
        query: searchQuery,
        maxResults: 10,
        emailAccountId: params.emailAccountId,
      });

      logger.info("Search results for Gmail URL", {
        resultKeys: Object.keys(searchResults),
        resultsCount: searchResults.results?.length || 0,
        sampleResult: searchResults.results?.[0],
      });

      // Return search results with helpful message
      return {
        _note:
          "Gmail search URL provided. Showing search results instead. Use get_email with a specific email ID from below to fetch full details.",
        searchQuery,
        originalUrl: params.emailId,
        ...searchResults,
      };
    } catch (error) {
      logger.error("Error searching emails from Gmail URL", {
        error,
        query: searchQuery,
      });
      throw error;
    }
  }

  // Check if this is a Gmail inbox/label URL with base64url ID (UI format)
  // These IDs might work with the threads.get API instead of messages.get
  const isLikelyThreadId =
    params.emailId.includes("mail.google.com") &&
    (params.emailId.includes("#inbox/") ||
      params.emailId.includes("#label/") ||
      params.emailId.includes("#starred/") ||
      params.emailId.includes("#sent/")) &&
    /[A-Z]/.test(params.emailId); // Base64url IDs contain uppercase letters

  // Extract email ID from Gmail URL if provided
  const emailId = extractEmailId(params.emailId);

  const targetAccountId = params.emailAccountId || context.emailAccountId;

  logger.info("MCP tool: get_email", {
    userId: context.userId,
    requestedAccountId: params.emailAccountId,
    defaultAccountId: context.emailAccountId,
    targetAccountId,
    emailId,
    originalInput: params.emailId !== emailId ? params.emailId : undefined,
  });

  // Helper function to fetch email from a specific account
  const fetchFromAccount = async (accountId: string) => {
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: accountId },
      include: { account: true },
    });

    if (!emailAccount) {
      throw new Error(`Email account ${accountId} not found`);
    }

    const isGmail = isGoogleProvider(emailAccount.account?.provider);

    if (isGmail) {
      const gmail = await getGmailClientWithRefresh({
        accessToken: emailAccount.account?.access_token,
        refreshToken: emailAccount.account?.refresh_token,
        expiresAt: emailAccount.account?.expires_at
          ? new Date(emailAccount.account.expires_at).getTime()
          : null,
        emailAccountId: emailAccount.id,
        logger,
      });

      // Try to fetch as a thread first if it looks like a UI thread ID
      if (isLikelyThreadId) {
        try {
          logger.trace("Attempting to fetch as thread (UI ID format)", {
            emailId,
          });
          const thread = await getThread(emailId, gmail);

          // Get the first (most recent) message from the thread
          const firstMessage = thread.messages?.[0];
          if (firstMessage) {
            const message = parseMessage(firstMessage);

            // Download and parse attachments
            const gmailAttachments: GmailAttachment[] =
              message.attachments?.map((a) => ({
                attachmentId: a.attachmentId, // ParsedMessage.Attachment uses 'attachmentId'
                filename: a.filename,
                mimeType: a.mimeType,
                size: a.size,
              })) || [];

            const parsedAttachments = await downloadAndParseAttachments(
              message.id || emailId,
              gmailAttachments,
              gmail,
              {
                maxSizeBytes: 10 * 1024 * 1024, // 10MB limit for non-PDF files
                parsePdf: true,
                parseImages: false,
                parseDocuments: false,
                maxPdfPages: 50, // Parse up to 50 pages for large PDFs
                streamLargePdfs: true, // Enable streaming for PDFs >10MB
              },
              logger,
            );

            return {
              id: message.id || "",
              threadId: thread.id || "",
              from: message.headers?.from || "",
              to: message.headers?.to || "",
              cc: message.headers?.cc || "",
              subject: message.headers?.subject || "",
              date: message.headers?.date || "",
              textPlain: message.textPlain || "",
              textHtml: message.textHtml || "",
              snippet: message.snippet || "",
              attachments: parsedAttachments,
              accountId: emailAccount.id,
              accountEmail: emailAccount.email,
            };
          }
        } catch (threadError) {
          logger.trace("Thread fetch failed, trying message fetch", {
            error: threadError,
          });
          // Fall through to regular message fetch
        }
      }

      // Regular message fetch
      const rawMessage = await getGmailMessage(emailId, gmail, "full");
      const message = parseMessage(rawMessage);

      // Download and parse attachments
      const gmailAttachments: GmailAttachment[] =
        message.attachments?.map((a) => ({
          attachmentId: a.attachmentId, // ParsedMessage.Attachment uses 'attachmentId'
          filename: a.filename,
          mimeType: a.mimeType,
          size: a.size,
        })) || [];

      const parsedAttachments = await downloadAndParseAttachments(
        message.id || emailId,
        gmailAttachments,
        gmail,
        {
          maxSizeBytes: 10 * 1024 * 1024, // 10MB limit for non-PDF files
          parsePdf: true,
          parseImages: false,
          parseDocuments: false,
          maxPdfPages: 50, // Parse up to 50 pages for large PDFs
          streamLargePdfs: true, // Enable streaming for PDFs >10MB
        },
        logger,
      );

      return {
        id: message.id || "",
        threadId: message.threadId || "",
        from: message.headers?.from || "",
        to: message.headers?.to || "",
        cc: message.headers?.cc || "",
        subject: message.headers?.subject || "",
        date: message.headers?.date || "",
        textPlain: message.textPlain || "",
        textHtml: message.textHtml || "",
        snippet: message.snippet || "",
        attachments: parsedAttachments,
        accountId: emailAccount.id,
        accountEmail: emailAccount.email,
      };
    } else {
      const outlook = createOutlookClient(
        emailAccount.account.access_token!,
        logger,
      );
      const message = await getOutlookMessage(emailId, outlook, logger);

      return {
        id: message.id,
        threadId: message.conversationIndex || "",
        from: message.headers.from,
        to: message.headers.to,
        cc: message.headers.cc,
        subject: message.headers.subject,
        date: message.headers.date,
        textPlain: message.textPlain || "",
        textHtml: message.textHtml || "",
        snippet: message.snippet || "",
        attachments:
          message.attachments?.map((a) => ({
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
          })) || [],
        accountId: emailAccount.id,
        accountEmail: emailAccount.email,
      };
    }
  };

  // Try the target account first
  try {
    return await fetchFromAccount(targetAccountId);
  } catch (error) {
    // If emailAccountId was explicitly specified, don't try other accounts
    if (params.emailAccountId) {
      throw error;
    }

    // Otherwise, try all linked accounts
    logger.info(
      "Email not found in default account, trying all linked accounts",
      {
        userId: context.userId,
        defaultAccountId: targetAccountId,
      },
    );

    const allAccounts = await prisma.emailAccount.findMany({
      where: {
        userId: context.userId,
        id: { not: targetAccountId },
      },
    });

    for (const account of allAccounts) {
      try {
        return await fetchFromAccount(account.id);
      } catch (err) {}
    }

    // If we get here, email wasn't found in any account
    throw new Error(
      `Email ID "${emailId}" not found in any of your ${allAccounts.length + 1} linked email accounts.`,
    );
  }
}

/**
 * List all email accounts for the authenticated user
 */
export async function listEmailAccounts(
  context: McpToolContext,
  params: Record<string, never>,
) {
  logger.info("MCP tool: list_email_accounts", {
    userId: context.userId,
  });

  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId: context.userId },
    select: {
      id: true,
      email: true,
      account: {
        select: {
          provider: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return {
    accounts: emailAccounts.map((account) => ({
      id: account.id,
      email: account.email,
      provider: account.account?.provider || "unknown",
      isDefault: account.id === context.emailAccountId,
    })),
    count: emailAccounts.length,
  };
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
    from?: string;
    cc?: string[];
    bcc?: string[];
  },
) {
  logger.info("MCP tool: send_email", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    to: params.to,
    subject: params.subject,
    from: params.from,
  });

  // Validate required parameters
  if (!params.to || !Array.isArray(params.to) || params.to.length === 0) {
    throw new Error(
      "Missing required parameter 'to'. Must be a non-empty array of email addresses.",
    );
  }
  if (!params.subject || typeof params.subject !== "string") {
    throw new Error(
      "Missing required parameter 'subject'. Must be a non-empty string.",
    );
  }
  if (!params.body || typeof params.body !== "string") {
    throw new Error(
      "Missing required parameter 'body'. Must be a non-empty string.",
    );
  }

  // If 'from' is specified, look up the email account by email address
  let emailAccountId = context.emailAccountId;

  if (params.from) {
    // Validate that 'from' looks like an email address
    if (!params.from.includes("@")) {
      const allAccounts = await prisma.emailAccount.findMany({
        where: { userId: context.userId },
        select: { email: true },
      });
      const availableEmails = allAccounts.map((a) => a.email).join(", ");
      throw new Error(
        `Invalid 'from' parameter: "${params.from}". The 'from' must be a valid email address. ` +
          `Available accounts: ${availableEmails}`,
      );
    }

    const fromAccount = await prisma.emailAccount.findFirst({
      where: {
        userId: context.userId,
        email: params.from,
      },
      select: { id: true, email: true },
    });

    if (!fromAccount) {
      const allAccounts = await prisma.emailAccount.findMany({
        where: { userId: context.userId },
        select: { email: true },
      });
      const availableEmails = allAccounts.map((a) => a.email).join(", ");
      throw new Error(
        `Email account '${params.from}' not found. ` +
          `You must use one of your configured accounts: ${availableEmails}`,
      );
    }

    emailAccountId = fromAccount.id;
    logger.info("Using specified email account", {
      from: params.from,
      emailAccountId: fromAccount.id,
    });
  }

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
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
    const gmail = await getGmailClientWithRefresh({
      accessToken: emailAccount.account?.access_token,
      refreshToken: emailAccount.account?.refresh_token,
      expiresAt: emailAccount.account?.expires_at
        ? new Date(emailAccount.account.expires_at).getTime()
        : null,
      emailAccountId: emailAccount.id,
      logger,
    });

    const result = await gmailSendEmail(gmail, {
      to: params.to.join(", "),
      subject: params.subject,
      messageHtml,
      cc: params.cc?.join(", "),
      bcc: params.bcc?.join(", "),
    });

    return {
      success: true,
      messageId: result.data.id || "",
      threadId: result.data.threadId || "",
    };
  } else {
    const outlook = createOutlookClient(
      emailAccount.account.access_token!,
      logger,
    );

    const result = await outlookSendEmail(
      outlook,
      {
        to: params.to.join(", "),
        subject: params.subject,
        messageHtml,
        cc: params.cc?.join(", "),
        bcc: params.bcc?.join(", "),
      },
      logger,
    );

    return {
      success: true,
      messageId: result.id,
    };
  }
}
