/**
 * Gmail Attachment Utilities
 *
 * Download and parse Gmail attachments
 */

import type { gmail_v1 } from "@googleapis/gmail";
import type { Logger } from "@/utils/logger";
import { createScopedLogger } from "@/utils/logger";
import { withGmailRetry } from "@/utils/gmail/retry";
import {
  parseAttachment,
  type ParsedAttachment,
  type AttachmentParseOptions,
} from "@/utils/mcp-server/tools/attachment-parser";

const logger = createScopedLogger("gmail/attachment");

export interface GmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/**
 * Download attachment from Gmail
 */
export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
  gmail: gmail_v1.Gmail,
  attachmentLogger: Logger,
): Promise<Buffer> {
  attachmentLogger.info("Downloading attachment", {
    messageId,
    attachmentId,
    hasAttachmentId: !!attachmentId,
    attachmentIdType: typeof attachmentId,
  });

  return withGmailRetry(
    async () => {
      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: attachmentId,
      });

      if (!response.data.data) {
        throw new Error("No attachment data returned");
      }

      // Gmail returns base64url-encoded data
      const buffer = Buffer.from(response.data.data, "base64url");
      return buffer;
    },
    5, // maxRetries
    { logger: attachmentLogger },
  );
}

/**
 * @deprecated Use downloadGmailAttachment instead
 * Legacy function for backwards compatibility
 */
export async function getGmailAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  attachmentId: string,
) {
  return withGmailRetry(
    async () => {
      const response = await gmail.users.messages.attachments.get({
        userId: "me",
        id: attachmentId,
        messageId,
      });
      return response.data;
    },
    5, // maxRetries
    { logger },
  );
}

/**
 * Download and parse Gmail attachments
 */
export async function downloadAndParseAttachments(
  messageId: string,
  attachments: GmailAttachment[],
  gmail: gmail_v1.Gmail,
  options: AttachmentParseOptions,
  attachmentLogger: Logger,
): Promise<ParsedAttachment[]> {
  if (!attachments || attachments.length === 0) {
    return [];
  }

  attachmentLogger.info("Processing attachments", {
    messageId,
    count: attachments.length,
    filenames: attachments.map((a) => a.filename),
  });

  const results: ParsedAttachment[] = [];

  for (const attachment of attachments) {
    attachmentLogger.info("Processing single attachment", {
      filename: attachment.filename,
      attachmentId: attachment.attachmentId,
      hasAttachmentId: !!attachment.attachmentId,
    });

    try {
      // Download the attachment
      const buffer = await downloadGmailAttachment(
        messageId,
        attachment.attachmentId,
        gmail,
        attachmentLogger,
      );

      // Parse the attachment
      const parsed = await parseAttachment(
        buffer,
        attachment,
        options,
        attachmentLogger,
      );

      results.push(parsed);
    } catch (error) {
      attachmentLogger.error("Failed to download/parse attachment", {
        error,
        filename: attachment.filename,
        messageId,
      });

      // Return attachment metadata with error
      results.push({
        ...attachment,
        content: {
          type: "unsupported",
          error: `Failed to download: ${error instanceof Error ? error.message : "Unknown error"}`,
        },
      });
    }
  }

  return results;
}
