import { describe, expect, it } from "vitest";
import { getAttachmentDownloadHeaders } from "./download-headers";

describe("getAttachmentDownloadHeaders", () => {
  it("never serves the sender-declared type", () => {
    const headers = getAttachmentDownloadHeaders("invoice.svg");

    expect(headers.get("Content-Type")).toBe("application/octet-stream");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Content-Disposition")).toMatch(/^attachment;/);
  });

  it("cannot break out of the quoted filename", () => {
    const disposition = getAttachmentDownloadHeaders(
      'a"; filename="evil.html',
    ).get("Content-Disposition");

    expect(disposition).toContain('filename="a_; filename=_evil.html"');
    expect(disposition?.match(/filename="/g)).toHaveLength(1);
  });

  it("keeps the real name for downloads via RFC 5987", () => {
    const disposition = getAttachmentDownloadHeaders("résumé.pdf").get(
      "Content-Disposition",
    );

    expect(disposition).toContain('filename="r_sum_.pdf"');
    expect(disposition).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
  });
});
