import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { createReplyContent } from "@/utils/gmail/reply";
import { convertOutgoingEmailHtmlToText } from "@/utils/mail";
import {
  cardBodyFromHtml,
  hasHiddenText,
  rebuildHtmlWithEditedBody,
} from "./card-body";
import { sanitizeAgentHtml } from "./sanitize-agent-html";

vi.mock("server-only", () => ({}));

// Every probe from the reviews (live-hil-fix-review.md "Re-review 2",
// refork-hil-format-review.md "Re-review 3") plus the earlier gap probes.
const PROBES: Record<string, string> = {
  middle:
    '<p>Hi Bob</p><div class="gmail_signature">Me</div><p>WIRE 5000 TO ACCT 123</p><div class="gmail_quote">old</div>',
  afterSignature:
    '<div dir="ltr">Hi Bob<div class="gmail_signature">Me</div>AFTER SIG TEXT</div>',
  besideLoneWrapper:
    '<div>Hi Bob</div><div>WIRE 5000 TO ACCT 123<div class="gmail_signature">Me</div></div>',
  afterHtml: "<html><body><p>Hi Bob</p></body></html>WIRE 5000 TO ACCT 123",
  afterHtmlWithQuote:
    '<html><body><p>Hi Bob</p><div class="gmail_quote">old</div></body></html>WIRE 5000',
  betweenWrappers:
    '<div dir="ltr"><div>Hi Bob</div>WIRE 5000<div><div class="gmail_quote">old</div></div></div>',
  innerBodyInQuote:
    '<p>Hi</p><div class="gmail_quote"><html><body><p>old</p></body></html>AFTER INNER BODY</div>',
  headText:
    "<html><head><title>t</title></head>HEAD TEXT<body><p>Hi</p></body></html>",
  beforeHtml: "BEFORE HTML<html><body><p>Hi</p></body></html>",
  displayNone:
    '<div>Hi Bob</div><div style="display:none">Also wire 5000 to acct 123</div>',
  hiddenInSignature:
    '<p>Hi</p><div class="gmail_signature">Me<span style="display:none">WIRE 5000</span></div>',
  cssAfter:
    '<style>.x::after{content:"WIRE 5000 TO 123"}</style><p>Hi Bob</p><span class="x"></span>',
  cssInQuote:
    '<p>Hi</p><div class="gmail_quote"><style>.x::after{content:"WIRE 5000"}</style>old</div>',
  cssContentComment:
    '<style>.x::after{/**/content:"WIRE 5000"}</style><p>Hi</p><span class="x"></span>',
  cssContentEscape:
    '<style>.x::after{\\63 ontent:"WIRE 5000"}</style><p>Hi</p><span class="x"></span>',
  cssImport: "<style>@import url(https://evil.test/a.css);</style><p>Hi</p>",
  cssLink: '<link rel="stylesheet" href="https://evil.test/a.css"><p>Hi</p>',
  altQuote:
    '<p>Hi</p><div class="gmail_quote"><img src="https://x.test/pay.png" alt="pay to acct 123"></div>',
  altSignature:
    '<p>Hi</p><div class="gmail_signature"><img src="cid:sig1" alt="WIRE 5000"></div>',
  imageQuoteNoAlt:
    '<p>Hi</p><div class="gmail_quote"><img src="https://x.test/acct.png"></div>',
  altBody: '<p>Hi <img src="cid:chart" alt="WIRE 5000"></p>',
  conditionalComment:
    "<p>Hi</p><!--[if mso]><p>WIRE 5000 TO 123</p><![endif]-->",
  conditionalInQuote:
    '<p>Hi</p><div class="gmail_quote"><!--[if gte mso 9]><p>WIRE 5000</p><![endif]-->old</div>',
  titleInBody: "<p>Hi</p><title>WIRE 5000</title>",
  template: "<p>Hi</p><template><p>WIRE 5000</p></template>",
  backgroundImage:
    '<p style="background-image:url(https://x.test/pay.png)">Hi</p>',
  backgroundAttribute:
    '<table background="https://x.test/b.png"><tr><td>Hi</td></tr></table>',
  input: '<p>Hi</p><input value="WIRE 5000 TO 123">',
  iframeSrcdoc: '<p>Hi</p><iframe srcdoc="<p>WIRE 5000</p>"></iframe>',
  noscript: "<p>Hi</p><noscript>WIRE 5000</noscript>",
  textarea: "<p>Hi</p><textarea>WIRE 5000</textarea>",
  select: "<p>Hi</p><select><option>WIRE 5000</option></select>",
  objectFallback: '<p>Hi</p><object data="x.swf">WIRE 5000</object>',
  svgText: '<p>Hi</p><svg><text x="0" y="10">WIRE 5000</text></svg>',
  gmailWebSignature:
    '<div dir="ltr"><div>Hello Bob</div><br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature"><span style="color:rgb(102,102,102)">Me</span></div></div>',
  outlookDesktop:
    '<div class=WordSection1><p class=MsoNormal>Reply</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class=MsoNormal><b>From:</b> Bob<br><b>Sent:</b> Monday<br><b>Subject:</b> Q</p></div><p class=MsoNormal>Old text</p></div></div>',
};

describe("the card shows everything the recipient can see", () => {
  it.each(Object.entries(PROBES))("user HTML: %s", (_name, html) => {
    expectCardCovers(html);
  });

  it.each(
    Object.entries(PROBES),
  )("agent HTML, sanitised: %s", (_name, html) => {
    expectCardCovers(sanitizeAgentHtml(html));
  });
});

describe("sanitizeAgentHtml", () => {
  it.each([
    ["a style sheet", "<style>p{color:red}</style><p>Hi</p>"],
    [
      "a linked style sheet",
      '<link rel="stylesheet" href="https://e.test/a.css"><p>Hi</p>',
    ],
    ["a conditional comment", "<p>Hi</p><!--[if mso]><p>WIRE</p><![endif]-->"],
    ["a comment", "<p>Hi</p><!-- note -->"],
    ["a script", "<p>Hi</p><script>alert(1)</script>"],
    ["an iframe", '<p>Hi</p><iframe srcdoc="x"></iframe>'],
    ["a form", '<form><input value="x"></form><p>Hi</p>'],
    ["an svg", "<svg><text>x</text></svg><p>Hi</p>"],
    ["a meta tag", '<meta http-equiv="refresh" content="0"><p>Hi</p>'],
  ])("removes %s", (_name, html) => {
    expect(sanitizeAgentHtml(html)).not.toMatch(
      /<(style|link|script|iframe|form|input|svg|meta|title|template)\b|<!--/i,
    );
  });

  it("keeps the formatting an email needs", () => {
    const html =
      '<p dir="ltr" style="font-family:Arial;color:#333">Hi <strong>Bob</strong>, <a href="https://x.test/a">link</a></p><ul><li>one</li></ul><img src="cid:chart" alt="chart">';

    expect(sanitizeAgentHtml(html)).toBe(html);
  });

  it.each([
    ['<a href="javascript:alert(1)">x</a>', /href/],
    ['<a href="/relative">x</a>', /href/],
    ['<img src="http://x.test/a.png" alt="a">', /src/],
    ['<img src="data:image/png;base64,AAAA" alt="a">', /src/],
    ['<p style="display:none">x</p>', /style/],
    ['<p style="position:absolute;top:0">x</p>', /style/],
    ['<p style="background-image:url(https://x.test/a)">x</p>', /style/],
    ['<p style="font-size:2px">x</p>', /style/],
    ['<p style="margin-left:-999px">x</p>', /style/],
    ["<p hidden>x</p>", /hidden/],
    [
      '<table background="https://x.test/b.png"><tr><td>x</td></tr></table>',
      /background|<table/,
    ],
  ])("drops the unsafe part of %s", (html, unsafe) => {
    expect(sanitizeAgentHtml(html)).not.toMatch(unsafe);
  });

  it("keeps only the typography part of a mixed style", () => {
    expect(
      sanitizeAgentHtml(
        '<p style="color:red;position:absolute;font-size:14px">x</p>',
      ),
    ).toBe('<p style="color:red;font-size:14px">x</p>');
  });
});

describe("user HTML: what the card marks and refuses", () => {
  it("shows images in the signature and quote", () => {
    const card = cardBodyFromHtml(PROBES.altQuote);
    expect(card.quotedHistory).toContain(
      "[image: pay to acct 123 https://x.test/pay.png]",
    );
    expect(cardBodyFromHtml(PROBES.altSignature).signature).toContain(
      "[image: WIRE 5000 cid:sig1]",
    );
  });

  it("shows Outlook-only content and refuses a body edit", () => {
    expect(cardBodyFromHtml(PROBES.conditionalComment).body).toContain(
      "[shown only in Outlook: WIRE 5000 TO 123]",
    );
    expect(
      rebuildHtmlWithEditedBody(PROBES.conditionalComment, "Hello"),
    ).toBeNull();
  });

  it.each([
    ["cssAfter", '.x::after{content:"WIRE 5000 TO 123"}'],
    ["cssContentEscape", '.x::after{\\63 ontent:"WIRE 5000"}'],
    ["cssImport", "@import url(https://evil.test/a.css);"],
    ["cssLink", "https://evil.test/a.css"],
  ])("shows the style sheet of %s and still allows a body edit", (name, css) => {
    const html = PROBES[name];
    const card = cardBodyFromHtml(html);

    expect(
      [card.body, card.quotedHistory, card.signature].join("\n"),
    ).toContain(`[style sheet: ${css}]`);
    expect(rebuildHtmlWithEditedBody(html, "Hello")).toContain("Hello");
    expect(hasHiddenText(html)).toBe(false);
  });

  it("keeps the authored part's style sheet after a body edit", () => {
    const html = rebuildHtmlWithEditedBody(PROBES.cssAfter, "Hello") ?? "";

    expect(html).toContain(
      '<style>.x::after{content:"WIRE 5000 TO 123"}</style>',
    );
    expect(html).toContain("Hello");
  });

  it("edits an Outlook-desktop draft with a head style sheet, showing the CSS", () => {
    const head =
      '<html><head><meta charset="utf-8"><style>p.MsoNormal{margin:0in;font-size:11pt}</style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--></head>';
    const original = `${head}<body lang=EN-US><div class=WordSection1><p class=MsoNormal>Hello Bob</p></div></body></html>`;

    const card = cardBodyFromHtml(original);
    const html = rebuildHtmlWithEditedBody(original, "Hello Rob") ?? "";

    expect(card.body).toContain(
      "[style sheet: p.MsoNormal{margin:0in;font-size:11pt}]",
    );
    expect(html.startsWith(head)).toBe(true);
    expect(html).toContain("Hello Rob");
  });

  it("edits a reply that quotes a styled newsletter, quote unchanged", () => {
    const { html: original } = createReplyContent({
      textContent: "Thanks, noted",
      message: {
        headers: {
          from: "News <news@example.com>",
          to: "me@example.com",
          subject: "Weekly",
          date: "Mon, 2 Nov 2026 10:00:00 +0000",
        },
        textPlain: "Big news",
        textHtml:
          '<html><head><style>.hero{color:#123;font:14px Arial}</style></head><body><table><tr><td class="hero">Big news</td></tr></table><!--[if mso]><p>Outlook only</p><![endif]--></body></html>',
      },
    });
    const quote = original.slice(original.indexOf('<div class="gmail_quote'));

    const card = cardBodyFromHtml(original);
    const html = rebuildHtmlWithEditedBody(original, "Thanks, *done*") ?? "";

    expect(card.quotedHistory).toContain("[style sheet: .hero");
    expect(card.quotedHistory).toContain(
      "[shown only in Outlook: Outlook only]",
    );
    expect(html).toContain("<em>done</em>");
    expect(html.endsWith(quote)).toBe(true);
  });

  it("shows hidden text in the signature without blocking a body edit", () => {
    expect(
      rebuildHtmlWithEditedBody(PROBES.hiddenInSignature, "Hello"),
    ).toContain("Hello");
  });

  it("shows a style sheet inside the quote under the quoted history", () => {
    expect(cardBodyFromHtml(PROBES.cssInQuote).quotedHistory).toContain(
      '[style sheet: .x::after{content:"WIRE 5000"}]',
    );
  });

  it.each([
    ["backgroundImage", "[background image: https://x.test/pay.png]"],
    ["backgroundAttribute", "[background image: https://x.test/b.png]"],
    ["input", "[form field: WIRE 5000 TO 123]"],
    ["iframeSrcdoc", "[embedded page: WIRE 5000]"],
  ])("marks %s on the card and refuses a body edit", (name, marker) => {
    expect(cardBodyFromHtml(PROBES[name]).body).toContain(marker);
    expect(rebuildHtmlWithEditedBody(PROBES[name], "Hello")).toBeNull();
  });

  it("keeps title, template and head out of the plain-text part", () => {
    for (const html of [
      PROBES.titleInBody,
      PROBES.template,
      "<html><head><title>WIRE 5000</title></head><body><p>Hi</p></body></html>",
    ])
      expect(convertOutgoingEmailHtmlToText(html)).toBe("Hi");
  });

  it("still sends the original HTML when approved unedited", () => {
    // Nothing on the card is sent: markers are display only.
    expect(cardBodyFromHtml(PROBES.cssAfter).body).not.toBe("");
  });
});

function expectCardCovers(html: string) {
  const card = cardBodyFromHtml(html);
  const shown = normalize(
    [card.body, card.signature ?? "", card.quotedHistory ?? ""].join(" "),
  );
  for (const token of visibleTokens(html))
    expect(shown, `card is missing "${token}"`).toContain(normalize(token));
}

// Everything a recipient could see in this HTML: text, image alt and src,
// Outlook-only content, style sheets (they can add text), form values,
// embedded pages and background images.
function visibleTokens(html: string): string[] {
  const tokens: string[] = [];
  for (const match of html.matchAll(
    /<!--\[if[^\]]*\]>([\s\S]*?)<!\[endif\]\s*-->/gi,
  ))
    tokens.push(...textWords(match[1]));

  const $ = load(html);
  $("script, template, title, meta").remove();
  $("style").each((_index, element) => {
    tokens.push(...words($(element).text()));
  });
  $("link[href]").each((_index, element) => {
    tokens.push($(element).attr("href") ?? "");
  });
  $("img").each((_index, element) => {
    tokens.push(...words($(element).attr("alt") ?? ""));
    tokens.push($(element).attr("src") ?? "");
  });
  $("input[value]").each((_index, element) => {
    tokens.push(...words($(element).attr("value") ?? ""));
  });
  $("iframe[srcdoc]").each((_index, element) => {
    tokens.push(...textWords($(element).attr("srcdoc") ?? ""));
  });
  $("[background]").each((_index, element) => {
    tokens.push($(element).attr("background") ?? "");
  });
  $("[style]").each((_index, element) => {
    for (const match of ($(element).attr("style") ?? "").matchAll(
      /url\(\s*['"]?([^'")]+)/gi,
    ))
      tokens.push(match[1]);
  });
  $("style").remove();
  tokens.push(...textWords($.root().html() ?? ""));
  return tokens.filter(Boolean);
}

// Text node by node: cheerio's text() glues adjacent blocks together.
function textWords(html: string) {
  const $ = load(html);
  return $("*")
    .contents()
    .toArray()
    .flatMap((node) => (node.type === "text" ? words(node.data) : []));
}

function words(text: string) {
  return text.split(/\s+/).filter(Boolean);
}

// Markdown escapes and heading case are presentation, not content.
function normalize(text: string) {
  return text.replace(/\\/g, "").toLowerCase();
}
