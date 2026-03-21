/**
 * Attachment Parser
 *
 * Parses email attachments and extracts content:
 * - PDF: Extract text
 * - Images: OCR (future)
 * - Office docs: Extract text (future)
 */

import type { Logger } from "@/utils/logger";
import { extractText, getDocumentProxy } from "unpdf";

export interface ParsedAttachment {
  filename: string;
  mimeType: string;
  size: number;
  attachmentId?: string;
  content?: {
    type: "pdf" | "image" | "document" | "text" | "unsupported";
    text?: string;
    pageCount?: number;
    metadata?: Record<string, any>;
    error?: string;
  };
}

export interface AttachmentParseOptions {
  maxSizeBytes?: number; // Default: 10MB
  parsePdf?: boolean; // Default: true
  parseImages?: boolean; // Default: false (requires vision API)
  parseDocuments?: boolean; // Default: false (requires mammoth/xlsx)
  maxPdfPages?: number; // Default: 50 - max pages to parse for large PDFs
  streamLargePdfs?: boolean; // Default: true - use streaming for files >10MB
}

const DEFAULT_OPTIONS: Required<AttachmentParseOptions> = {
  maxSizeBytes: 10 * 1024 * 1024, // 10MB
  parsePdf: true,
  parseImages: false,
  parseDocuments: false,
  maxPdfPages: 50,
  streamLargePdfs: true,
};

/**
 * Parse PDF with streaming/chunked approach for large files
 */
async function parsePdfStreaming(
  uint8Array: Uint8Array,
  filename: string,
  maxPages: number,
  logger: Logger,
): Promise<ParsedAttachment["content"]> {
  try {
    const doc = await getDocumentProxy(uint8Array);
    const totalPages = doc.numPages;
    const pagesToParse = Math.min(totalPages, maxPages);

    logger.info("Parsing large PDF with streaming", {
      filename,
      totalPages,
      pagesToParse,
      truncated: totalPages > maxPages,
    });

    const textParts: string[] = [];

    // Parse pages incrementally
    for (let pageNum = 1; pageNum <= pagesToParse; pageNum++) {
      const page = await doc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(" ");
      textParts.push(pageText);

      // Log progress for very large files
      if (pageNum % 10 === 0) {
        logger.trace("PDF parsing progress", {
          filename,
          pagesProcessed: pageNum,
          totalPages: pagesToParse,
        });
      }
    }

    const fullText = textParts.join("\n\n");
    const truncationNote =
      totalPages > maxPages
        ? `\n\n[Note: This PDF has ${totalPages} total pages. Only the first ${maxPages} pages are shown above. The full document is available in the email.]`
        : "";

    logger.info("Large PDF parsed successfully", {
      filename,
      totalPages,
      pagesParsed: pagesToParse,
      textLength: fullText.length,
      truncated: totalPages > maxPages,
    });

    return {
      type: "pdf",
      text: fullText + truncationNote,
      pageCount: totalPages,
      metadata: {
        truncated: totalPages > maxPages,
        pagesParsed: pagesToParse,
      },
    };
  } catch (error) {
    logger.error("Streaming PDF parsing failed", { error, filename });
    return {
      type: "pdf",
      error: `Failed to parse PDF: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Parse PDF attachment (handles both small and large files)
 */
async function parsePdf(
  buffer: Buffer,
  filename: string,
  options: Required<AttachmentParseOptions>,
  logger: Logger,
): Promise<ParsedAttachment["content"]> {
  try {
    // Convert Buffer to Uint8Array for unpdf
    const uint8Array = new Uint8Array(buffer);
    const fileSizeBytes = buffer.length;
    const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB

    // Use streaming parser for large files
    if (
      options.streamLargePdfs &&
      fileSizeBytes > LARGE_FILE_THRESHOLD
    ) {
      logger.info("Using streaming parser for large PDF", {
        filename,
        sizeMB: (fileSizeBytes / 1024 / 1024).toFixed(2),
      });
      return parsePdfStreaming(
        uint8Array,
        filename,
        options.maxPdfPages,
        logger,
      );
    }

    // Use fast extraction for small files
    const { text, totalPages } = await extractText(uint8Array);

    logger.info("PDF parsed successfully", {
      filename,
      pages: totalPages,
      textLength: text.length,
    });

    return {
      type: "pdf",
      text,
      pageCount: totalPages,
      metadata: {},
    };
  } catch (error) {
    logger.error("PDF parsing failed", { error, filename });
    return {
      type: "pdf",
      error: `Failed to parse PDF: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Parse plain text attachment
 */
function parseText(buffer: Buffer, filename: string): ParsedAttachment["content"] {
  try {
    const text = buffer.toString("utf-8");
    return {
      type: "text",
      text,
    };
  } catch (error) {
    return {
      type: "text",
      error: `Failed to parse text: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

/**
 * Main attachment parser
 */
export async function parseAttachment(
  buffer: Buffer,
  attachment: {
    filename: string;
    mimeType: string;
    size: number;
    attachmentId?: string;
  },
  options: AttachmentParseOptions,
  logger: Logger,
): Promise<ParsedAttachment> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const mimeType = attachment.mimeType.toLowerCase();

  logger.info("parseAttachment called", {
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    mimeTypeLower: mimeType,
    size: attachment.size,
    isPdf: mimeType === "application/pdf",
  });

  // PDF - handle both small and large files with streaming
  if (mimeType === "application/pdf" && opts.parsePdf) {
    // For PDFs, we don't enforce maxSizeBytes strictly - streaming handles large files
    // But we still have a sanity limit to prevent abuse
    const ABSOLUTE_MAX_SIZE = 50 * 1024 * 1024; // 50MB absolute max
    if (attachment.size > ABSOLUTE_MAX_SIZE) {
      logger.warn("PDF exceeds absolute size limit", {
        filename: attachment.filename,
        size: attachment.size,
        limit: ABSOLUTE_MAX_SIZE,
      });
      return {
        ...attachment,
        content: {
          type: "unsupported",
          error: `File too large (${(attachment.size / 1024 / 1024).toFixed(2)}MB). Maximum: ${(ABSOLUTE_MAX_SIZE / 1024 / 1024).toFixed(2)}MB`,
        },
      };
    }

    const content = await parsePdf(buffer, attachment.filename, opts, logger);
    return { ...attachment, content };
  }

  // For non-PDF files, enforce the size limit
  if (attachment.size > opts.maxSizeBytes) {
    logger.info("Attachment too large to parse", {
      filename: attachment.filename,
      size: attachment.size,
      limit: opts.maxSizeBytes,
    });

    return {
      ...attachment,
      content: {
        type: "unsupported",
        error: `File too large (${(attachment.size / 1024 / 1024).toFixed(2)}MB). Maximum: ${(opts.maxSizeBytes / 1024 / 1024).toFixed(2)}MB`,
      },
    };
  }

  // Plain text
  if (
    mimeType === "text/plain" ||
    mimeType === "text/csv" ||
    mimeType === "text/html"
  ) {
    const content = parseText(buffer, attachment.filename);
    return { ...attachment, content };
  }

  // Images (future - requires vision API)
  if (mimeType.startsWith("image/") && opts.parseImages) {
    return {
      ...attachment,
      content: {
        type: "image",
        error: "Image parsing not yet implemented. Coming soon with vision API!",
      },
    };
  }

  // Office documents (future - requires mammoth/xlsx)
  if (
    (mimeType.includes("word") ||
      mimeType.includes("excel") ||
      mimeType.includes("powerpoint") ||
      mimeType.includes("officedocument")) &&
    opts.parseDocuments
  ) {
    return {
      ...attachment,
      content: {
        type: "document",
        error: "Office document parsing not yet implemented. Coming soon!",
      },
    };
  }

  // Unsupported type
  return {
    ...attachment,
    content: {
      type: "unsupported",
      error: `Unsupported file type: ${mimeType}`,
    },
  };
}
