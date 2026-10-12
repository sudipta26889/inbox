/**
 * Attachment bytes come from whoever sent the email, so they are always a
 * download: never served with the sender-declared type (an HTML or SVG
 * attachment would otherwise render as our origin), never sniffed.
 * Adapted from upstream 64830555b (#3798).
 */
export function getAttachmentDownloadHeaders(filename: string) {
  const asciiName =
    filename.replace(/[^\x20-\x7e]|["\\]/g, "_").trim() || "attachment";
  const headers = new Headers();
  headers.set("Content-Type", "application/octet-stream");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Content-Disposition",
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  return headers;
}
