import { describe, it, expect } from "vitest";
import { parseAttachment } from "./attachment-parser";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("attachment-parser-test");

// %PDF-1.4 header is enough to exercise the routing decision; text extraction
// may or may not succeed, but the content type must be "pdf" either way.
const pdfBytes = Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n", "latin1");

describe("parseAttachment PDF detection", () => {
  it("routes octet-stream PDFs (mislabeled by sender) to the PDF parser", async () => {
    const result = await parseAttachment(
      pdfBytes,
      {
        filename: "110626I049906258.pdf",
        mimeType: "application/octet-stream",
        size: pdfBytes.length,
      },
      {},
      logger,
    );

    expect(result.content?.type).toBe("pdf");
    expect(result.content?.type).not.toBe("unsupported");
  });

  it("detects PDF by magic bytes even without a .pdf extension", async () => {
    const result = await parseAttachment(
      pdfBytes,
      {
        filename: "statement",
        mimeType: "application/octet-stream",
        size: pdfBytes.length,
      },
      {},
      logger,
    );

    expect(result.content?.type).toBe("pdf");
  });

  it("leaves genuinely unsupported octet-stream files as unsupported", async () => {
    const zipBytes = Buffer.from("PK\x03\x04somezipdata", "latin1");
    const result = await parseAttachment(
      zipBytes,
      {
        filename: "archive.zip",
        mimeType: "application/octet-stream",
        size: zipBytes.length,
      },
      {},
      logger,
    );

    expect(result.content?.type).toBe("unsupported");
  });
});
