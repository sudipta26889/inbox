import { load } from "cheerio";
import type { Element } from "domhandler";
import { Marked, type Tokens } from "marked";
import TurndownService from "turndown";
import { SIGNATURE_SELECTORS } from "@/utils/email/signature-normalization";
import { convertOutgoingEmailHtmlToText } from "@/utils/mail";
import { escapeHtml } from "@/utils/string";

/**
 * The approval card shows what the user (or AI) wrote as Markdown, so bold,
 * links and lists stay visible and editable, and shows the signature and the
 * quoted earlier messages as read-only text. An edit replaces only the
 * authored part; everything around it is sent byte-for-byte as it was.
 */
export type CardBody = {
  body: string;
  signature?: string;
  quotedHistory?: string;
};

export function cardBodyFromHtml(html: string): CardBody {
  const parts = splitOutgoingHtml(html);
  const signature = htmlText(parts.signature);
  const quotedHistory = htmlText(parts.quoted);
  return {
    body: htmlToMarkdown(parts.authored),
    ...(signature && { signature }),
    ...(quotedHistory && { quotedHistory }),
  };
}

export function rebuildHtmlWithEditedBody(html: string, markdown: string) {
  const parts = splitOutgoingHtml(html);
  return `${parts.head}${markdownToSafeHtml(markdown)}${parts.signature}${parts.quoted}${parts.tail}`;
}

// Same boundaries the reader uses (split-email-content.client.ts, which needs
// a browser DOM), plus the quote block createOutlookReplyContent writes.
const QUOTE_SELECTOR = [
  ".gmail_quote_container",
  "div.gmail_quote",
  'div[id$="divRplyFwdMsg"]',
  'div[id$="appendonsend"]',
  ".yahoo_quoted",
  ".moz-cite-prefix",
  'blockquote[type="cite"]',
  'div[style^="border-top: 1px solid #e1e1e1"]',
].join(", ");

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
}).remove(["script", "style", "head", "title"]);

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    // Never pass HTML typed on the card through to the email.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    link({ href, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      return SAFE_URL.test(href)
        ? `<a href="${escapeHtml(href)}">${text}</a>`
        : text;
    },
    image: ({ href, text }: Tokens.Image) =>
      SAFE_URL.test(href)
        ? `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}">`
        : escapeHtml(text),
  },
});
const SAFE_URL = /^(https?:|mailto:|tel:)/i;

/**
 * Cuts the HTML at source offsets so the signature and quote are slices of the
 * original string: reassembly can never alter them.
 *
 * ponytail: a wrapper opened before the signature (Gmail's `<div dir="ltr">`)
 * closes inside the signature slice, so an edited body leaves one stray
 * closing tag, which every mail client ignores.
 */
function splitOutgoingHtml(html: string) {
  const isDocument = /<(?:html|body)[\s>]/i.test(html);
  const $ = load(html, { sourceCodeLocationInfo: true }, isDocument);
  const offset = (node: Element | undefined) =>
    node?.sourceCodeLocation?.startOffset;

  const bodyLocation = isDocument
    ? $("body").get(0)?.sourceCodeLocation
    : undefined;
  const start = bodyLocation?.startTag?.endOffset ?? 0;
  const end = bodyLocation?.endTag?.startOffset ?? html.length;

  const quoteStart = offset($(QUOTE_SELECTOR).get(0));
  const signatureSelector = SIGNATURE_SELECTORS.join(", ");
  const signatureStart = offset(
    $(signatureSelector)
      .filter(
        (_index, element) =>
          $(element).parents(`${signatureSelector}, ${QUOTE_SELECTOR}`)
            .length === 0,
      )
      .get(0),
  );
  const ownSignatureStart =
    signatureStart !== undefined &&
    (quoteStart === undefined || signatureStart < quoteStart)
      ? signatureStart
      : undefined;

  const quotedFrom = quoteStart ?? end;
  const authoredEnd = ownSignatureStart ?? quotedFrom;
  return {
    head: html.slice(0, start),
    authored: html.slice(start, authoredEnd),
    signature: html.slice(authoredEnd, quotedFrom),
    quoted: html.slice(quotedFrom, end),
    tail: html.slice(end),
  };
}

function htmlToMarkdown(html: string) {
  return turndown.turndown(html).trim();
}

function markdownToSafeHtml(markdown: string) {
  return (marked.parse(markdown) as string).trim();
}

function htmlText(html: string) {
  return html.trim() ? convertOutgoingEmailHtmlToText(html) : "";
}
