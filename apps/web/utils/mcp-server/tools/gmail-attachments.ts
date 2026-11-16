import type { gmail_v1 } from "@googleapis/gmail";
import type { Logger } from "@/utils/logger";
import { getGmailAttachment } from "@/utils/gmail/attachment";
import {
  parseAttachment,
  type ParsedAttachment,
  type AttachmentParseOptions,
} from "@/utils/mcp-server/tools/attachment-parser";

export interface GmailAttachment {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export async function downloadGmailAttachment(
  messageId: string,
  attachmentId: string,
  gmail: gmail_v1.Gmail,
  attachmentLogger: Logger,
): Promise<Buffer> {
  attachmentLogger.info("Downloading attachment", { messageId, attachmentId });

  const data = await getGmailAttachment(gmail, messageId, attachmentId);
  if (!data.data) throw new Error("No attachment data returned");

  // Gmail returns base64url-encoded data
  return Buffer.from(data.data, "base64url");
}

export async function downloadAndParseAttachments(
  messageId: string,
  attachments: GmailAttachment[],
  gmail: gmail_v1.Gmail,
  options: AttachmentParseOptions,
  attachmentLogger: Logger,
): Promise<ParsedAttachment[]> {
  if (!attachments || attachments.length === 0) return [];

  attachmentLogger.info("Processing attachments", {
    messageId,
    count: attachments.length,
  });

  const results: ParsedAttachment[] = [];

  for (const attachment of attachments) {
    try {
      const buffer = await downloadGmailAttachment(
        messageId,
        attachment.attachmentId,
        gmail,
        attachmentLogger,
      );
      results.push(
        await parseAttachment(buffer, attachment, options, attachmentLogger),
      );
    } catch (error) {
      attachmentLogger.error("Failed to download/parse attachment", {
        error,
        messageId,
      });
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
