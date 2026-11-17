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
  /**
   * Read-only: what the authored part or the email around it holds that is
   * not plain authored text (style sheets, Outlook-only or hidden text, form
   * fields…). Kept out of the editable body so no marker is ever sent.
   */
  notices?: string;
};

export function cardBodyFromHtml(html: string): CardBody {
  const parts = splitOutgoingHtml(html);
  const bodyNotices: string[] = [];
  const body = htmlToMarkdown(cardHtml(parts.inner, false), bodyNotices);
  const field = (text: string, where: Extra["field"]) =>
    [
      text,
      ...parts.extras
        .filter((extra) => extra.field === where)
        .map((extra) => extra.marker),
    ]
      .filter(Boolean)
      .join("\n\n");
  const signature = field(htmlText(cardHtml(parts.signature)), "signature");
  const quotedHistory = field(htmlText(cardHtml(parts.quoted)), "quoted");
  const notices = field(bodyNotices.join("\n\n"), "body");
  return {
    body,
    ...(signature && { signature }),
    ...(quotedHistory && { quotedHistory }),
    ...(notices && { notices }),
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
  if (parts.extras.some((extra) => extra.blocksEdit)) return null;
  const $inner = load(parts.inner, null, false);
  const style = commonTypography($inner);
  if (style === null) return null;

  const imageSources = new Map<string, string>();
  $inner("img[src]").each((_index, element) => {
    const src = $inner(element).attr("src") ?? "";
    imageSources.set(src, src);
    imageSources.set(encodeURI(src), src);
  });

  // The edit carries no style sheet, so the original's typography (its class
  // rules and common inline style, through the typography allowlist) goes
  // inline on every edited block instead.
  const edited = withBlockStyle(
    inOriginalBlocks(markdownToSafeHtml(markdown, imageSources), $inner),
    mergeStyles(classTypography(html, $inner), style),
  );

  const rebuilt = [
    parts.head,
    parts.prefix,
    edited,
    parts.suffix,
    parts.signature,
    parts.quoted,
    parts.tail,
  ].join("");
  // Style sheets apply to the whole email and can match the edit's new
  // structure, so an edited send carries none: formatting may go, but no
  // edited word can be hidden.
  return withoutStyleSheets(rebuilt);
}

/** The HTML with every style sheet, linked sheet and Outlook-only block cut out. */
function withoutStyleSheets(html: string) {
  const isDocument = /<(?:html|head|body)[\s>]/i.test(html);
  const $ = load(html, { sourceCodeLocationInfo: true }, isDocument);
  const ranges = [
    ...$("style, link").toArray(),
    ...commentNodes($.root().get(0)).filter((node) =>
      /^\s*\[\s*if\b/i.test(node.data),
    ),
  ]
    .map((node) => node.sourceCodeLocation)
    .filter((location) => !!location)
    .map((location) => [location.startOffset, location.endOffset] as const)
    .sort((a, b) => b[0] - a[0]);
  let result = html;
  for (const [from, to] of ranges)
    result = result.slice(0, from) + result.slice(to);
  return result;
}

/**
 * Typography the original's first classed block gets from style sheet rules
 * for its class (Outlook's p.MsoNormal, Gmail's .gmail_default), read through
 * the typography allowlist. Only innermost rules with a plain .class or
 * tag.class selector count; nothing here can hide text.
 */
function classTypography(html: string, $inner: CheerioAPI) {
  const block = $inner("p[class], div[class]").first();
  const tag = block.get(0)?.name;
  const classes = (block.attr("class") ?? "").toLowerCase().split(/\s+/);
  if (!tag || !classes[0]) return "";
  const wanted = new Set(
    classes.flatMap((name) => [`.${name}`, `${tag}.${name}`]),
  );
  const $ = load(html);
  const css = $("style")
    .toArray()
    .map((element) => $(element).text())
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/<!--|-->/g, " ");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selectors]) =>
      selectors
        .split(",")
        .some((selector) => wanted.has(selector.trim().toLowerCase())),
    )
    .map(([, , declarations]) => typographyOnly(declarations))
    .filter(Boolean)
    .join(";");
}

// Later declarations win, as in CSS.
function mergeStyles(...styles: string[]) {
  const merged = new Map<string, string>();
  for (const style of styles)
    for (const declaration of style.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon > 0)
        merged.set(
          declaration.slice(0, colon).trim(),
          declaration.slice(colon + 1).trim(),
        );
    }
  return [...merged]
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

/** True when the authored part holds text the reader can't see. */
export function hasHiddenText(html: string) {
  return hasHidden(load(splitOutgoingHtml(html).inner, null, false));
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
const UNEDITABLE_SELECTOR =
  "table, input, button, textarea, select, form, iframe, object, embed, svg, [background]";
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
  // Hidden text still reaches text/plain and some clients, so the reviewer
  // must see it, marked. Its presence also refuses body edits.
  .addRule("hiddenText", {
    filter: (node) =>
      node.hasAttribute?.("hidden") ||
      isHiddenStyle(node.getAttribute?.("style") ?? ""),
    replacement: (content) => {
      collectedNotices?.push(`[hidden in the email: ${content.trim()}]`);
      return "";
    },
  });

const SAFE_URL = /^(https?:|mailto:|tel:)/i;

// Markers are card text, not email text, so Markdown must not escape them.
turndown.addRule("cardMarker", {
  filter: (node) => node.nodeName === "CARD-MARKER",
  replacement: (_content, node) => {
    collectedNotices?.push((node.textContent ?? "").trim());
    return "";
  },
});

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
  // Text after it (parsers move it into the body) must stay on the card.
  const closing = isDocument
    ? [lower.lastIndexOf("</body"), lower.lastIndexOf("</html")].find(
        (index) => index >= start && !hasVisibleContent(html.slice(index)),
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
    !hasVisibleContent(html.slice(signatureEnd, quotedFrom))
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

  // Kept slices around the body must hold only tags: anything visible in them
  // would be sent without being on the card.
  if (
    hasVisibleContent(html.slice(start, innerStart)) ||
    hasVisibleContent(html.slice(innerEnd, authoredEnd))
  ) {
    innerStart = start;
    innerEnd = authoredEnd;
  }

  // Shown in the field they sit in. Only Outlook-only content in the authored
  // part refuses a body edit: the edit can't reproduce it. Style sheets are
  // shown in full and kept; the signature and quote are reattached as they
  // were.
  const fieldAt = (offset: number): Extra["field"] =>
    quoteStart !== undefined && offset >= quotedFrom
      ? "quoted"
      : offset >= authoredEnd && offset < quotedFrom
        ? "signature"
        : "body";
  const extras: Extra[] = [
    // Outlook renders conditional comments; every other reader skips them.
    // Any comment opening with "[if", however it is spaced or closed.
    ...commentNodes($.root().get(0))
      .filter((node) => /^\s*\[\s*if\b/i.test(node.data))
      .map((node) => {
        const offset = startOf(node) ?? 0;
        const content = node.data
          .replace(/^\s*\[[^\]]*\]\s*>?/, "")
          .replace(/<!\[\s*endif\s*\][\s\S]*$/i, "");
        return {
          offset,
          marker: `[shown only in Outlook: ${htmlText(cardHtml(content))}]`,
          blocksEdit: offset >= start && offset < authoredEnd,
        };
      }),
    // A style sheet can add text (content:, @import, linked CSS), so the
    // reviewer sees all of it rather than a guess at what it does.
    ...$("style")
      .toArray()
      .map((element) => ({
        offset: startOf(element) ?? 0,
        marker: `[style sheet: ${$(element).text().trim()}]`,
        blocksEdit: false,
      })),
    // The page background is outside every card field's slice.
    ...$("html, body")
      .toArray()
      .flatMap((element) => backgroundUrls($(element)))
      .map((url) => ({
        offset: 0,
        marker: `[background image: ${url}]`,
        blocksEdit: false,
      })),
    ...$("link[href]")
      .toArray()
      .map((element) => ({
        offset: startOf(element) ?? 0,
        marker: `[style sheet: ${$(element).attr("href")}]`,
        blocksEdit: false,
      })),
  ]
    .sort((a, b) => a.offset - b.offset)
    .map(({ offset, marker, blocksEdit }) => ({
      field: fieldAt(offset),
      marker,
      blocksEdit,
    }));

  return {
    extras,
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
  if (hasHidden($)) return null;
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
    if ([color, face].some((value) => value && !isSafeStyleValue(value)))
      return null;
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
    if (!isAcceptableDeclaration(property, value)) return null;
    declarations.push([property, value]);
  }
  return declarations;
}

function hasHidden($: CheerioAPI) {
  return (
    $("[hidden]").length > 0 ||
    $("[style]")
      .toArray()
      .some((element) => isHiddenStyle(element.attribs.style ?? ""))
  );
}

// Ways to keep text in the email while the reader can't see it.
function isHiddenStyle(style: string) {
  const css = style.toLowerCase().replace(/\s+/g, "");
  if (
    /(^|;)display:none/.test(css) ||
    /(^|;)visibility:hidden/.test(css) ||
    /(^|;)opacity:0*(\.0*)?%?(;|!|$)/.test(css) ||
    /(^|;)font-size:0*(\.0*)?[a-z%]*(;|!|$)/.test(css)
  )
    return true;
  const value = (property: string) =>
    css.match(new RegExp(`(?:^|;)${property}:([^;!]+)`))?.[1];
  const color = value("color");
  return (
    !!color &&
    (color === value("background-color") || color === value("background"))
  );
}

// A typography value that can't be used to hide text or inject anything.
function isAcceptableDeclaration(property: string, value: string) {
  if (!isSafeStyleValue(value)) return false;
  if (/calc\(|var\(|\d\s*(vw|vh|vmin|vmax)\b/i.test(value)) return false;
  if (property === "font-size") return !isTinyFontSize(value);
  if (property === "color")
    return !/transparent|(rgba?|hsla?)\(\s*[^,)]+,\s*[^,)]+,\s*[^,)]+,\s*0*(\.0*)?%?\s*\)|\/\s*0*(\.0*)?%?\s*\)/i.test(
      value,
    );
  if (property === "line-height") return !/^0*(\.0*)?[a-z%]*$/i.test(value);
  if (/^(margin|padding)/.test(property))
    return [...value.matchAll(/([\d.]+)\s*(px|pt|em|rem)?/gi)].every(
      ([, size, unit]) => toPixels(Number.parseFloat(size), unit) <= 200,
    );
  return true;
}

function toPixels(size: number, unit = "px") {
  const lower = unit.toLowerCase();
  if (lower === "pt") return (size * 4) / 3;
  if (lower === "em" || lower === "rem") return size * 16;
  if (lower === "%") return (size / 100) * 16;
  return size;
}

function isSafeStyleValue(value: string) {
  return !/url\(|expression|\/\*|\\|(^|[\s,(])-[\d.]/i.test(value);
}

// Below 8px text is unreadable on purpose; px, pt, em/rem and % are checked.
function isTinyFontSize(value: string) {
  const match = value.trim().match(/^([\d.]+)(px|pt|em|rem|%)?$/i);
  if (!match) return false;
  return toPixels(Number.parseFloat(match[1]), match[2]) < 8;
}

function textNodes(node: AnyNode | undefined): AnyNode[] {
  if (!node) return [];
  if (node.type === "text")
    return "data" in node && node.data.trim() ? [node] : [];
  return "children" in node ? node.children.flatMap(textNodes) : [];
}

/**
 * Paragraphs take the original authored part's block shape, so the edit adds
 * no tag a style sheet could target: <p> stays <p> (Outlook), and anything
 * else (Gmail compose divs, text with <br>) gets Gmail's own shape, a <div>
 * per paragraph with <div><br></div> between them.
 */
function inOriginalBlocks(html: string, $inner: CheerioAPI) {
  if ($inner("p").length) return html;
  const $ = load(html, null, false);
  const blocks = $.root().children().toArray();
  for (const block of blocks)
    if (block.name === "p")
      $(block).replaceWith($("<div>").html($(block).html() ?? ""));
  return $.root()
    .children()
    .toArray()
    .map((block) => $.html(block))
    .join("<div><br></div>");
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

function hasVisibleContent(fragment: string) {
  if (!fragment.trim()) return false;
  const $ = load(fragment, null, false);
  return (
    !!$.root().text().trim() ||
    $("img, input[value], iframe, [background], [style*='url(']").length > 0
  );
}

type Extra = {
  field: "body" | "signature" | "quoted";
  marker: string;
  blocksEdit: boolean;
};

/**
 * The HTML a card field is rendered from: things a reader sees that are not
 * text become text markers, and what no reader sees is dropped. Images in
 * the body stay, as Markdown shows them.
 */
function cardHtml(fragment: string, markImages = true) {
  if (!fragment.trim()) return fragment;
  const $ = load(fragment, null, false);
  const marker = (text: string) => $("<card-marker>").text(` ${text} `);
  $("script, template, title, meta, style, link").remove();
  if (markImages)
    $("img").each((_index, element) => {
      const image = $(element);
      const label = [image.attr("alt"), image.attr("src")]
        .filter(Boolean)
        .join(" ");
      image.replaceWith(marker(`[image: ${label}]`));
    });
  $("input[value]").each((_index, element) => {
    $(element).after(marker(`[form field: ${$(element).attr("value")}]`));
  });
  $("iframe").each((_index, element) => {
    const frame = $(element);
    const page = frame.attr("srcdoc");
    frame.replaceWith(
      marker(
        `[embedded page: ${page === undefined ? (frame.attr("src") ?? "") : load(page).root().text().trim()}]`,
      ),
    );
  });
  $("[background], [style*='url(']").each((_index, element) => {
    for (const url of backgroundUrls($(element)))
      $(element).prepend(marker(`[background image: ${url}]`));
  });
  return $.root().html() ?? fragment;
}

function backgroundUrls(element: ReturnType<CheerioAPI>): string[] {
  return [
    element.attr("background"),
    ...[
      ...(element.attr("style") ?? "").matchAll(/url\(\s*['"]?([^'")]+)/gi),
    ].map((match) => match[1]),
  ].filter((url): url is string => !!url);
}

/** The typography part of an inline style ("" when none is kept). */
export function typographyOnly(style: string) {
  return style
    .split(";")
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      return [
        declaration.slice(0, colon).trim().toLowerCase(),
        declaration.slice(colon + 1).trim(),
      ];
    })
    .filter(
      ([property, value]) =>
        TYPOGRAPHY_PROPERTY.test(property) &&
        value &&
        isAcceptableDeclaration(property, value),
    )
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
}

function commentNodes(
  node: AnyNode | undefined,
): (AnyNode & { data: string })[] {
  if (!node) return [];
  if (node.type === "comment") return [node as AnyNode & { data: string }];
  return "children" in node ? node.children.flatMap(commentNodes) : [];
}

function startOf(node: AnyNode | undefined) {
  return node?.sourceCodeLocation?.startOffset;
}

function isBlank(node: AnyNode) {
  if (node.type === "text") return !("data" in node && node.data.trim());
  if (node.type === "comment") return true;
  return node.type === "tag" && (node as Element).name === "br";
}

// ponytail: module state, safe because turndown runs synchronously.
let collectedNotices: string[] | null = null;

function htmlToMarkdown(html: string, notices: string[]) {
  collectedNotices = notices;
  try {
    return turndown.turndown(html).trim();
  } finally {
    collectedNotices = null;
  }
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
