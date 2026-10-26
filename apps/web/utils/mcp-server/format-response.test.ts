import { describe, expect, it, vi } from "vitest";
import {
  formatEmailAsMarkdown,
  formatToolResponse,
} from "@/utils/mcp-server/format-response";

vi.mock("server-only", () => ({}));

const base = {
  id: "1a0635a3df016e0e",
  from: "noreply-dgftbo@gov.in",
  subject: "Mandatory Updation of Importer-Exporter Code (IEC) Details",
  date: "Tue, 2 Sep 2026 10:00:00 +0530",
};

describe("formatEmailAsMarkdown", () => {
  it("renders the body of an html-only email instead of the snippet", () => {
    const md = formatEmailAsMarkdown({
      ...base,
      textPlain: "",
      textHtml:
        '<html><body><p>Update your IEC before <b>30 Sep</b>.</p><a href="https://dgft.gov.in/iec">Update now</a></body></html>',
      snippet: "Update your IEC before",
    });

    expect(md).toContain("Update your IEC before");
    expect(md).toContain("30 Sep");
    expect(md).toContain("https://dgft.gov.in/iec");
    expect(md).not.toContain("snippet only");
  });

  it("prefers text/plain when both parts are present", () => {
    const md = formatEmailAsMarkdown({
      ...base,
      textPlain: "plain version",
      textHtml: "<p>html version</p>",
    });

    expect(md).toContain("plain version");
    expect(md).not.toContain("html version");
  });

  it("says so explicitly when it can only fall back to the snippet", () => {
    const md = formatEmailAsMarkdown({ ...base, snippet: "just a snippet" });

    expect(md).toContain("Could not extract a body");
    expect(md).toContain("just a snippet");
  });

  it("truncates an oversized body with a visible marker", () => {
    const md = formatEmailAsMarkdown({
      ...base,
      textPlain: "x".repeat(20_050),
    });

    expect(md).toContain("_[truncated: 50 more characters]_");
  });
});

describe("formatEmailAsMarkdown attachments", () => {
  it("prints each attachment's id so get_attachment can fetch it", () => {
    const md = formatEmailAsMarkdown({
      ...base,
      textPlain: "see attached",
      attachments: [
        {
          attachmentId: "ANGjdJ8abc",
          filename: "statement.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    });

    expect(md).toContain("- **Attachment ID:** `ANGjdJ8abc`");
  });
});

describe("formatToolResponse get_attachment", () => {
  it("returns parseable JSON rather than markdown", () => {
    const result = {
      filename: "statement.pdf",
      mimeType: "application/pdf",
      size: 3,
      data: "YWJj",
    };

    expect(JSON.parse(formatToolResponse("get_attachment", result))).toEqual(
      result,
    );
  });
});
