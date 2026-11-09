import { load } from "cheerio";
import { convertNewlinesToBr, escapeHtml } from "@/utils/string";

// Reply bodies mix plain text with trusted HTML such as signatures. Only
// top-level text gets line breaks, so source newlines between signature tags
// don't turn into visible gaps.
export function renderReplyBodyHtml(content: string): string {
  const $ = load(content, null, false);

  $.root()
    .contents()
    .each((_index, node) => {
      if (node.type !== "text") return;

      $(node).replaceWith(convertNewlinesToBr(escapeHtml(node.data)));
    });

  return $.root().html() ?? "";
}

// The marker lets the composer separate the signature again even when a
// provider normalizes its inner HTML before the draft is reopened.
// Inside the wrapper the text is no longer top-level, so a plain-text
// signature's newlines become <br> here; HTML signatures pass through.
export function wrapSignature(signature: string): string {
  return `<div class="gmail_signature" data-smartmail="gmail_signature">${renderReplyBodyHtml(signature)}</div>`;
}
