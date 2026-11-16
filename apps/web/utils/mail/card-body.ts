import { type CheerioAPI, load } from "cheerio";
import type { AnyNode, Element } from "domhandler";
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
    body: htmlToMarkdown(parts.inner),
    ...(signature && { signature }),
    ...(quotedHistory && { quotedHistory }),
  };
}

/**
 * The full HTML with the authored part replaced, or null when the authored
 * part holds something the Markdown round trip would silently drop.
 */
export function rebuildHtmlWithEditedBody(
  html: string,
  markdown: string,
): string | null {
  const parts = splitOutgoingHtml(html);
  const $inner = load(parts.inner, null, false);
  const style = commonTypography($inner);
  if (style === null) return null;

  const imageSources = new Map<string, string>();
  $inner("img[src]").each((_index, element) => {
    const src = $inner(element).attr("src") ?? "";
    imageSources.set(src, src);
    imageSources.set(encodeURI(src), src);
  });

  return [
    parts.head,
    parts.prefix,
    withBlockStyle(markdownToSafeHtml(markdown, imageSources), style),
    parts.suffix,
    parts.signature,
    parts.quoted,
    parts.tail,
  ].join("");
}

// Same boundaries the reader uses (split-email-content.client.ts, which needs
// a browser DOM), plus the quote block createOutlookReplyContent writes and
// the headers of Outlook for Mac / new Outlook and old Hotmail.
const QUOTE_SELECTOR = [
  ".gmail_quote_container",
  "div.gmail_quote",
  'div[id$="divRplyFwdMsg"]',
  'div[id$="appendonsend"]',
  ".yahoo_quoted",
  ".moz-cite-prefix",
  'blockquote[type="cite"]',
  'div[style^="border-top: 1px solid #e1e1e1"]',
  "#mail-editor-reference-message-container",
  "hr#stopSpelling",
].join(", ");

// Markdown can't carry these, so an edit would lose them without a word.
const UNEDITABLE_SELECTOR = "table, style";
// Inline styles an edit can keep by putting them on every edited block.
const TYPOGRAPHY_PROPERTY =
  /^(font-family|font-size|color|line-height|(margin|padding)(-(top|right|bottom|left))?)$/;
const STYLABLE_TAGS = new Set(["p", "div", "span"]);

const SIGNATURE_SELECTOR = SIGNATURE_SELECTORS.join(", ");

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  // A plain newline, which marked (breaks: true) turns back into <br>. Two
  // trailing spaces would be lost by any channel that trims the card text.
  br: "",
})
  .remove(["script", "style", "head", "title"])
  .remove((node) =>
    /display\s*:\s*none/i.test(node.getAttribute?.("style") ?? ""),
  );

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

// Two or more <br> in a row are a blank line: a paragraph break, not one
// line break. AI replies are built that way (renderReplyBodyHtml).
turndown.addRule("paragraphBreak", {
  filter: (node) =>
    node.nodeName === "BR" &&
    (isBreak(siblingSkippingSpace(node, "previousSibling")) ||
      isBreak(siblingSkippingSpace(node, "nextSibling"))),
  replacement: (_content, node) =>
    isBreak(siblingSkippingSpace(node as Node, "previousSibling"))
      ? ""
      : "\n\n",
});

/**
 * Cuts the HTML at source offsets so the signature, quote and every wrapper
 * around the authored text are slices of the original string: reassembly can
 * never alter them, and an edited body still sits inside its original
 * wrappers (Gmail's `<div dir="ltr">`, Outlook's font div), so the output
 * stays balanced.
 */
function splitOutgoingHtml(html: string) {
  const isDocument = /<(?:html|head|body)[\s>]/i.test(html);
  const $ = load(html, { sourceCodeLocationInfo: true }, isDocument);
  const lower = html.toLowerCase();

  const body = isDocument ? $("body").get(0) : undefined;
  const start =
    body?.sourceCodeLocation?.startTag?.endOffset ??
    $("head").get(0)?.sourceCodeLocation?.endOffset ??
    0;
  // The last closing tag: a quoted original often carries its own </body>.
  const closing = isDocument
    ? [lower.lastIndexOf("</body"), lower.lastIndexOf("</html")].find(
        (index) => index >= start,
      )
    : undefined;
  const quote = findQuote($, html);
  const quoteStart = startOf(quote);
  // Never before the quote, or the quote and tail slices would overlap.
  const end = Math.max(closing ?? html.length, quoteStart ?? 0);
  const quotedFrom = quoteStart ?? end;

  // Gmail web writes a "-- " prefix span, then the signature div: the cut is
  // at the first, the P.S. check runs from the end of the last.
  const signatures = $(SIGNATURE_SELECTOR)
    .filter(
      (_index, element) =>
        $(element).parents(`${SIGNATURE_SELECTOR}, ${QUOTE_SELECTOR}`)
          .length === 0 && (startOf(element) ?? end) < quotedFrom,
    )
    .toArray();
  const signature = signatures[0];
  const signatureStart = startOf(signature);
  const signatureEnd = signatures.at(-1)?.sourceCodeLocation?.endOffset;
  // Text after the signature (a P.S.) must stay editable, so then there is no
  // separate signature and it all belongs to the body.
  const ownSignature =
    signature &&
    signatureStart !== undefined &&
    signatureEnd !== undefined &&
    !load(html.slice(signatureEnd, quotedFrom), null, false)
      .root()
      .text()
      .trim()
      ? signature
      : undefined;

  const authoredEnd = ownSignature ? (signatureStart as number) : quotedFrom;
  const cut = ownSignature ?? quote;

  // Wrappers that open in the authored part and close after the cut.
  let innerStart = start;
  let container: AnyNode | undefined = body;
  if (cut) {
    for (const ancestor of $(cut).parents().toArray().reverse()) {
      const tag = ancestor.sourceCodeLocation?.startTag;
      if (!tag || tag.startOffset < innerStart) continue;
      if (html.slice(innerStart, tag.startOffset).trim()) break;
      innerStart = tag.endOffset;
      container = ancestor;
    }
  }

  // A lone wrapper div that holds all the authored text.
  let innerEnd = authoredEnd;
  for (;;) {
    const nodes = (container ? $(container).contents() : $.root().contents())
      .toArray()
      .filter((node) => {
        const location = node.sourceCodeLocation;
        return (
          !!location &&
          location.startOffset >= innerStart &&
          location.endOffset <= innerEnd &&
          !isBlank(node)
        );
      });
    const only = nodes.length === 1 ? nodes[0] : undefined;
    const location = only?.sourceCodeLocation;
    if (
      only?.type !== "tag" ||
      (only as Element).name !== "div" ||
      !location?.startTag ||
      !location.endTag
    )
      break;
    innerStart = location.startTag.endOffset;
    innerEnd = location.endTag.startOffset;
    container = only;
  }

  return {
    head: html.slice(0, start),
    prefix: html.slice(start, innerStart),
    inner: html.slice(innerStart, innerEnd),
    suffix: html.slice(innerEnd, authoredEnd),
    signature: html.slice(authoredEnd, quotedFrom),
    quoted: html.slice(quotedFrom, end),
    tail: html.slice(end),
  };
}

function findQuote($: CheerioAPI, html: string): Element | undefined {
  const candidates = [
    $(QUOTE_SELECTOR).get(0),
    $("div[style]")
      .filter((_index, element) => isWordReplyHeader($, element))
      .map((_index, element) => wordHeaderBlock(html, element))
      .get(0),
  ].filter((element): element is Element => startOf(element) !== undefined);
  return candidates.sort(
    (a, b) => (startOf(a) as number) - (startOf(b) as number),
  )[0];
}

// Outlook desktop (Word) writes the reply header as a bordered div holding
// From / Sent / To / Subject; Outlook 2007-2010 uses a blue border.
function isWordReplyHeader($: CheerioAPI, element: Element) {
  const style = ($(element).attr("style") ?? "")
    .toLowerCase()
    .replace(/\s+/g, "");
  if (
    !style.includes("border-top:solid#e1e1e1") &&
    !style.includes("border-top:solid#b5c4df")
  )
    return false;
  const text = $(element).text();
  return (
    /^\s*From:/.test(text) && /(Sent|Date):/.test(text) && /Subject:/.test(text)
  );
}

// Word wraps the header in a bare div that also holds the quoted message.
function wordHeaderBlock(html: string, element: Element): Element {
  const parent = element.parent as Element | null;
  const parentTag = parent?.sourceCodeLocation?.startTag;
  const start = startOf(element);
  if (
    parent?.type === "tag" &&
    parent.name === "div" &&
    Object.keys(parent.attribs).length === 0 &&
    parentTag &&
    start !== undefined &&
    html.slice(parentTag.endOffset, start).trim() === ""
  )
    return parent;
  return element;
}

/**
 * The one inline style every piece of authored text has (font, colour,
 * spacing), as a CSS string; "" when there is none; null when an edit can't
 * reproduce the styling: tables, layout or background styles, or text styled
 * differently from other text.
 */
function commonTypography($: CheerioAPI): string | null {
  if ($(UNEDITABLE_SELECTOR).length) return null;
  const declared = new Map<AnyNode, [string, string][]>();
  for (const element of $("[style], font").toArray()) {
    const declarations = styleOf(element);
    if (!declarations) return null;
    declared.set(element, declarations);
  }

  const styles = new Set<string>();
  for (const text of textNodes($.root().get(0))) {
    const effective = new Map<string, string>();
    const chain = $(text).parents().toArray().reverse();
    for (const ancestor of chain)
      for (const [property, value] of declared.get(ancestor) ?? [])
        effective.set(property, value);
    styles.add(
      [...effective]
        .map(([property, value]) => `${property}:${value}`)
        .join(";"),
    );
  }
  if (styles.size > 1) return null;
  return [...styles][0] ?? "";
}

function styleOf(element: Element): [string, string][] | null {
  if (element.name === "font") {
    const { color, face, ...other } = element.attribs;
    if (Object.keys(other).length) return null;
    return [
      ...(color ? ([["color", color]] as [string, string][]) : []),
      ...(face ? ([["font-family", face]] as [string, string][]) : []),
    ];
  }
  if (!STYLABLE_TAGS.has(element.name)) return null;
  const declarations: [string, string][] = [];
  for (const declaration of (element.attribs.style ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (colon < 0 || !TYPOGRAPHY_PROPERTY.test(property)) return null;
    declarations.push([property, value]);
  }
  return declarations;
}

function textNodes(node: AnyNode | undefined): AnyNode[] {
  if (!node) return [];
  if (node.type === "text")
    return "data" in node && node.data.trim() ? [node] : [];
  return "children" in node ? node.children.flatMap(textNodes) : [];
}

function withBlockStyle(html: string, style: string) {
  if (!style) return html;
  const $ = load(html, null, false);
  $.root().children().attr("style", style);
  return $.root().html() ?? html;
}

function siblingSkippingSpace(
  node: Node,
  direction: "previousSibling" | "nextSibling",
): Node | null {
  let sibling = node[direction];
  while (sibling && sibling.nodeType === 3 && !sibling.textContent?.trim())
    sibling = sibling[direction];
  return sibling;
}

function isBreak(node: Node | null) {
  return node?.nodeName === "BR";
}

function startOf(node: AnyNode | undefined) {
  return node?.sourceCodeLocation?.startOffset;
}

function isBlank(node: AnyNode) {
  if (node.type === "text") return !("data" in node && node.data.trim());
  if (node.type === "comment") return true;
  return node.type === "tag" && (node as Element).name === "br";
}

function htmlToMarkdown(html: string) {
  return turndown.turndown(html).trim();
}

// Never passes HTML typed on the card through to the email; images render
// only when their source was already in the authored part.
function markdownToSafeHtml(
  markdown: string,
  imageSources: Map<string, string>,
) {
  const marked = new Marked({
    gfm: true,
    breaks: true,
    async: false,
    renderer: {
      html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
      link({ href, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        return SAFE_URL.test(href)
          ? `<a href="${escapeHtml(href)}">${text}</a>`
          : text;
      },
      image({ href, text }: Tokens.Image) {
        const src = imageSources.get(href);
        return src === undefined
          ? escapeHtml(text)
          : `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}">`;
      },
    },
  });
  return (marked.parse(markdown) as string).trim();
}

function htmlText(html: string) {
  return html.trim() ? convertOutgoingEmailHtmlToText(html) : "";
}
