import prisma from "@/utils/prisma";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { createOutlookClient } from "@/utils/outlook/client";
import type { Attachment as MailAttachment } from "nodemailer/lib/mailer";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { createEmailProvider } from "@/utils/email/provider";
import { getEmailUrl } from "@/utils/url";
import { createScopedLogger } from "@/utils/logger";
import type { DraftStatus, ParsedMessage } from "@/utils/types";
import type { McpToolContext } from "./registry";
import { sendEmailWithHtml as gmailSendEmail } from "@/utils/gmail/mail";
import { sendEmailWithHtml as outlookSendEmail } from "@/utils/outlook/mail";
import {
  getMessage as getGmailMessage,
  parseMessage,
} from "@/utils/gmail/message";
import { getMessage as getOutlookMessage } from "@/utils/outlook/message";
import { extractEmailId } from "./url-parser";
import { getThread } from "@/utils/gmail/thread";
import {
  downloadAndParseAttachments,
  type GmailAttachment,
} from "@/utils/gmail/attachment";

const logger = createScopedLogger("mcp-email-tools");

type DraftAttachmentInput = {
  filename: string;
  content: string; // base64
  contentType?: string;
};

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
  });
  logger.trace("send_email params", {
    to: params.to,
    subject: params.subject,
    from: params.from,
  });

  assertMessageParams(params);

  const emailAccount = await resolveFromAccount(context, params.from);

  const isGmail = isGoogleProvider(emailAccount.account?.provider);

  const messageHtml = toMessageHtml(params.body);

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

/**
 * Create an unsent draft. Same shape as sendEmail, but nothing leaves the
 * mailbox until a human opens `webUrl` and sends it.
 */
export async function createDraft(
  context: McpToolContext,
  params: {
    to: string[];
    subject: string;
    body: string;
    from?: string;
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
    threadId?: string;
    inReplyTo?: string;
    attachments?: DraftAttachmentInput[];
  },
) {
  logger.info("MCP tool: create_draft", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    attachmentCount: params.attachments?.length ?? 0,
  });
  logger.trace("create_draft params", {
    to: params.to,
    subject: params.subject,
    from: params.from,
  });

  assertMessageParams(params);

  const { provider, emailAccount } = await getDraftProvider(
    context,
    params.from,
  );

  const draft = await provider.createDraft({
    to: params.to.join(", "),
    subject: params.subject,
    messageHtml: toMessageHtml(params.body, params.isHtml),
    cc: params.cc?.join(", "),
    bcc: params.bcc?.join(", "),
    threadId: params.threadId,
    replyToMessageId: params.inReplyTo,
    attachments: toMailAttachments(params.attachments),
  });

  return {
    success: true,
    draftId: draft.id,
    threadId: draft.threadId,
    webUrl: draftWebUrl(emailAccount, draft.threadId || draft.id),
  };
}

/**
 * Revise an existing draft in place. Omitted fields keep their current value,
 * so an agent can fix wording after human feedback without making a duplicate.
 */
export async function updateDraft(
  context: McpToolContext,
  params: {
    draftId: string;
    subject?: string;
    body?: string;
    to?: string[];
    cc?: string[];
    bcc?: string[];
    isHtml?: boolean;
    from?: string;
  },
) {
  logger.info("MCP tool: update_draft", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  assertDraftId(params.draftId);

  const { provider, emailAccount } = await getDraftProvider(
    context,
    params.from,
  );

  await provider.updateDraft(params.draftId, {
    subject: params.subject,
    messageHtml:
      params.body === undefined
        ? undefined
        : toMessageHtml(params.body, params.isHtml),
    to: params.to?.join(", "),
    cc: params.cc?.join(", "),
    bcc: params.bcc?.join(", "),
  });

  const updated = await provider.getDraft(params.draftId);

  return {
    success: true,
    draftId: params.draftId,
    threadId: updated?.threadId ?? "",
    webUrl: draftWebUrl(emailAccount, updated?.threadId || params.draftId),
  };
}

/**
 * List unsent drafts, newest first.
 */
export async function listDrafts(
  context: McpToolContext,
  params: { maxResults?: number; from?: string },
) {
  logger.info("MCP tool: list_drafts", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  const { provider, emailAccount } = await getDraftProvider(
    context,
    params.from,
  );

  const maxResults = Math.min(params.maxResults || 20, 50);
  const drafts = await provider.getDrafts({ maxResults });

  return {
    drafts: drafts.map((draft) => summarizeDraft(draft, emailAccount)),
    count: drafts.length,
    account: emailAccount.email,
  };
}

/**
 * Fetch one draft and what became of it. "sent" and "deleted" are opposite
 * outcomes for a review loop, so they are reported distinctly rather than
 * collapsing into a single "not found".
 */
export async function getDraftDetail(
  context: McpToolContext,
  params: { draftId: string; threadId?: string; from?: string },
) {
  logger.info("MCP tool: get_draft", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  assertDraftId(params.draftId);

  const { provider, emailAccount } = await getDraftProvider(
    context,
    params.from,
  );

  const draft = await provider.getDraft(params.draftId);

  if (draft) {
    return {
      found: true,
      status: "draft" as const,
      ...summarizeDraft(draft, emailAccount),
      body: draft.textPlain ?? draft.textHtml ?? "",
    };
  }

  const outcome = await provider.getDraftStatus(
    params.draftId,
    params.threadId,
  );

  return {
    found: false,
    status: outcome.status,
    draftId: params.draftId,
    threadId: outcome.threadId,
    messageId: outcome.messageId,
    webUrl:
      outcome.threadId || outcome.messageId
        ? draftWebUrl(emailAccount, outcome.threadId || outcome.messageId!)
        : undefined,
    message: DRAFT_OUTCOME_MESSAGE[outcome.status],
  };
}

const DRAFT_OUTCOME_MESSAGE: Record<DraftStatus["status"], string> = {
  draft: "Draft still unsent.",
  sent: "A human reviewed and sent this draft. See messageId for the sent message.",
  deleted: "A human deleted this draft without sending it.",
  unknown:
    "Draft is gone but the outcome could not be determined. Pass the threadId returned by create_draft to resolve whether it was sent.",
};

/**
 * Delete a superseded draft. Unsent mail only — a draft that has already been
 * sent is no longer a draft, and the provider read returns nothing for it.
 */
export async function deleteDraft(
  context: McpToolContext,
  params: { draftId: string; from?: string },
) {
  logger.info("MCP tool: delete_draft", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  assertDraftId(params.draftId);

  const { provider } = await getDraftProvider(context, params.from);

  const existing = await provider.getDraft(params.draftId);
  if (!existing) {
    return {
      success: false,
      draftId: params.draftId,
      message:
        "Draft not found. It was either already sent, already deleted, or belongs to a different account.",
    };
  }

  await provider.deleteDraft(params.draftId);

  return { success: true, draftId: params.draftId };
}

function assertMessageParams(params: {
  to: string[];
  subject: string;
  body: string;
}) {
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
}

function toMessageHtml(body: string, isHtml?: boolean) {
  return isHtml || body.includes("<") ? body : body.replace(/\n/g, "<br>");
}

function assertDraftId(draftId: string) {
  if (!draftId || typeof draftId !== "string") {
    throw new Error(
      "Missing required parameter 'draftId'. Use list_drafts to find it.",
    );
  }
}

function toMailAttachments(
  attachments?: DraftAttachmentInput[],
): MailAttachment[] | undefined {
  if (!attachments?.length) return undefined;

  return attachments.map((attachment) => {
    if (!attachment.filename || !attachment.content) {
      throw new Error(
        "Each attachment requires 'filename' and base64 'content'.",
      );
    }

    return {
      filename: attachment.filename,
      contentType: attachment.contentType || "application/octet-stream",
      content: Buffer.from(attachment.content, "base64"),
    };
  });
}

async function getDraftProvider(context: McpToolContext, from?: string) {
  const emailAccount = await resolveFromAccount(context, from);

  const provider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: emailAccount.account?.provider ?? "",
    logger,
  });

  return { provider, emailAccount };
}

function draftWebUrl(
  emailAccount: { email: string; account: { provider: string | null } | null },
  id: string,
) {
  return getEmailUrl(
    id,
    emailAccount.email,
    emailAccount.account?.provider ?? undefined,
  );
}

function summarizeDraft(
  draft: ParsedMessage,
  emailAccount: { email: string; account: { provider: string | null } | null },
) {
  // Gmail's draft id is not the message id; every draft tool needs the former.
  const draftId = draft.draftId ?? draft.id;

  return {
    draftId,
    threadId: draft.threadId,
    subject: draft.subject,
    to: draft.headers?.to ?? "",
    cc: draft.headers?.cc,
    bcc: draft.headers?.bcc,
    date: draft.date,
    snippet: draft.snippet,
    attachments: (draft.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    })),
    webUrl: draftWebUrl(emailAccount, draft.threadId || draftId),
  };
}

/**
 * Resolve which linked account to write from. `from` must match one of the
 * user's own accounts exactly — this is the trust boundary for both send and
 * draft, so failures name the valid accounts rather than falling back.
 */
async function resolveFromAccount(context: McpToolContext, from?: string) {
  let emailAccountId = context.emailAccountId;

  if (from) {
    if (!from.includes("@")) {
      throw new Error(
        `Invalid 'from' parameter: "${from}". The 'from' must be a valid email address. ` +
          `Available accounts: ${await listAccountEmails(context.userId)}`,
      );
    }

    const fromAccount = await prisma.emailAccount.findFirst({
      where: { userId: context.userId, email: from },
      select: { id: true },
    });

    if (!fromAccount) {
      throw new Error(
        `Email account '${from}' not found. ` +
          `You must use one of your configured accounts: ${await listAccountEmails(context.userId)}`,
      );
    }

    emailAccountId = fromAccount.id;
    logger.trace("Using specified email account", { from, emailAccountId });
  }

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    include: { account: true },
  });

  if (!emailAccount) throw new Error("Email account not found");

  return emailAccount;
}

async function listAccountEmails(userId: string) {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { email: true },
  });
  return accounts.map((a) => a.email).join(", ");
}
