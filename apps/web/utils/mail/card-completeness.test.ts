import { load } from "cheerio";
import { describe, expect, it, vi } from "vitest";
import { createReplyContent } from "@/utils/gmail/reply";
import { convertOutgoingEmailHtmlToText } from "@/utils/mail";
import {
  type CardBody,
  cardBodyFromHtml,
  hasHiddenText,
  rebuildHtmlWithEditedBody,
} from "./card-body";
import { sanitizeAgentHtml } from "./sanitize-agent-html";

vi.mock("server-only", () => ({}));

// Every probe from the reviews (live-hil-fix-review.md "Re-review 2",
// refork-hil-format-review.md "Re-review 3" and "Re-review 4") plus the
// earlier gap probes. @S@ becomes a sentinel unique to the probe.
const RAW_PROBES: Record<string, string> = {
  middle:
    '<p>Hi Bob</p><div class="gmail_signature">Me</div><p>@S@ TO ACCT 123</p><div class="gmail_quote">old</div>',
  afterSignature:
    '<div dir="ltr">Hi Bob<div class="gmail_signature">Me</div>@S@ AFTER SIG</div>',
  besideLoneWrapper:
    '<div>Hi Bob</div><div>@S@ TO ACCT 123<div class="gmail_signature">Me</div></div>',
  afterHtml: "<html><body><p>Hi Bob</p></body></html>@S@ TO ACCT 123",
  afterHtmlWithQuote:
    '<html><body><p>Hi Bob</p><div class="gmail_quote">old</div></body></html>@S@',
  betweenWrappers:
    '<div dir="ltr"><div>Hi Bob</div>@S@<div><div class="gmail_quote">old</div></div></div>',
  innerBodyInQuote:
    '<p>Hi</p><div class="gmail_quote"><html><body><p>old</p></body></html>@S@</div>',
  headText:
    "<html><head><title>t</title></head>@S@<body><p>Hi</p></body></html>",
  beforeHtml: "@S@<html><body><p>Hi</p></body></html>",
  displayNone: '<div>Hi Bob</div><div style="display:none">Also wire @S@</div>',
  hiddenInSignature:
    '<p>Hi</p><div class="gmail_signature">Me<span style="display:none">@S@</span></div>',
  cssAfter:
    '<style>.x::after{content:"@S@"}</style><p>Hi Bob</p><span class="x"></span>',
  cssInQuote:
    '<p>Hi</p><div class="gmail_quote"><style>.x::after{content:"@S@"}</style>old</div>',
  cssContentComment:
    '<style>.x::after{/**/content:"@S@"}</style><p>Hi</p><span class="x"></span>',
  cssContentEscape:
    '<style>.x::after{\\63 ontent:"@S@"}</style><p>Hi</p><span class="x"></span>',
  cssImport: "<style>@import url(https://evil.test/@S@.css);</style><p>Hi</p>",
  cssLink: '<link rel="stylesheet" href="https://evil.test/@S@.css"><p>Hi</p>',
  quoteStyleHidesP:
    '<div dir="ltr">Hi Bob</div><div class="gmail_quote"><style>p{display:none}</style>old @S@</div>',
  altQuote:
    '<p>Hi</p><div class="gmail_quote"><img src="https://x.test/pay.png" alt="@S@ pay"></div>',
  altSignature:
    '<p>Hi</p><div class="gmail_signature"><img src="cid:sig1" alt="@S@"></div>',
  imageQuoteNoAlt:
    '<p>Hi</p><div class="gmail_quote"><img src="https://x.test/@S@.png"></div>',
  altBody: '<p>Hi <img src="cid:chart" alt="@S@"></p>',
  conditionalComment: "<p>Hi</p><!--[if mso]><p>@S@ TO 123</p><![endif]-->",
  conditionalSpaced: "<p>Hi</p><!-- [if mso]><p>@S@</p><![endif]-->",
  conditionalEndVariant: "<p>Hi</p><!--[if mso]><p>@S@</p><![endif]>-->",
  conditionalUpper: "<p>Hi</p><!--[IF MSO]><p>@S@</p><![ENDIF]-->",
  conditionalInQuote:
    '<p>Hi</p><div class="gmail_quote"><!--[if gte mso 9]><p>@S@</p><![endif]-->old</div>',
  backgroundImage:
    '<p style="background-image:url(https://x.test/@S@.png)">Hi</p>',
  backgroundAttribute:
    '<table background="https://x.test/@S@.png"><tr><td>Hi</td></tr></table>',
  input: '<p>Hi</p><input value="@S@ TO 123">',
  iframeSrcdoc: '<p>Hi</p><iframe srcdoc="<p>@S@</p>"></iframe>',
  noscript: "<p>Hi</p><noscript>@S@</noscript>",
  textarea: "<p>Hi</p><textarea>@S@</textarea>",
  select: "<p>Hi</p><select><option>@S@</option></select>",
  objectFallback: '<p>Hi</p><object data="x.swf">@S@</object>',
  svgText: '<p>Hi</p><svg><text x="0" y="10">@S@</text></svg>',
  bidi: "<p>Hi ‮@S@‬</p>",
  gmailWebSignature:
    '<div dir="ltr"><div>Hello Bob</div><br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature"><span style="color:rgb(102,102,102)">Me @S@</span></div></div>',
  outlookDesktop:
    '<html><head><style>p.MsoNormal{margin:0in}</style><!--[if gte mso 9]><xml>@S@</xml><![endif]--></head><body><div class=WordSection1><p class=MsoNormal>Reply</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class=MsoNormal><b>From:</b> Bob<br><b>Sent:</b> Monday<br><b>Subject:</b> Q</p></div><p class=MsoNormal>Old text</p></div></div></body></html>',
  // Not shown by any reader.
  titleInBody: "<p>Hi</p><title>@S@</title>",
  template: "<p>Hi</p><template><p>@S@</p></template>",
  plainComment: "<p>Hi</p><!-- @S@ -->",
};
const INVISIBLE = new Set(["titleInBody", "template", "plainComment"]);
const PROBES = Object.fromEntries(
  Object.entries(RAW_PROBES).map(([name, html]) => [
    name,
    html.replaceAll("@S@", sentinel(name)),
  ]),
);
const MARKERS =
  /\[(style sheet|shown only in Outlook|hidden in the email|image|form field|embedded page|background image):/;

describe("the card shows everything the recipient can see", () => {
  it.each(Object.keys(PROBES))("user HTML: %s", (name) => {
    const html = PROBES[name];
    const card = cardBodyFromHtml(html);

    if (!INVISIBLE.has(name))
      expect(shown(card)).toContain(sentinel(name).toLowerCase());
    expectCovers(card, html);
  });

  it.each(Object.keys(PROBES))("agent HTML, sanitised: %s", (name) => {
    const html = sanitizeAgentHtml(PROBES[name]);
    const card = cardBodyFromHtml(html);

    if (html.includes(sentinel(name)))
      expect(shown(card)).toContain(sentinel(name).toLowerCase());
    expectCovers(card, html);
  });
});

describe("an edit made on the card sends only what the card shows", () => {
  const paths = Object.keys(PROBES).flatMap((name) => [
    ["user", name, PROBES[name]],
    ["agent", name, sanitizeAgentHtml(PROBES[name])],
  ]);

  it.each(paths)("%s HTML: %s", (_path, _name, html) => {
    const card = cardBodyFromHtml(html);
    const edited = card.body.replace(/[A-Za-z]{2,}/, "Yo");

    const sent = rebuildHtmlWithEditedBody(html, edited);
    if (sent === null) return; // refused: nothing is sent

    expect(sent).not.toMatch(MARKERS);
    expect(convertOutgoingEmailHtmlToText(sent)).not.toMatch(MARKERS);
    expectCovers({ ...card, body: edited }, sent);
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
    ['<p style="font-size:0.3em">x</p>', /style/],
    ['<p style="font-size:1vw">x</p>', /style/],
    ['<p style="font-size:calc(1px + 1px)">x</p>', /style/],
    ['<p style="font-size:var(--s)">x</p>', /style/],
    ['<p style="color:transparent">x</p>', /style/],
    ['<p style="color:rgba(0,0,0,0)">x</p>', /style/],
    ['<p style="color:hsla(0,0%,0%,0)">x</p>', /style/],
    ['<p style="color:rgb(0 0 0 / 0)">x</p>', /style/],
    ['<p style="line-height:0">x</p>', /style/],
    ['<p style="margin-left:-999px">x</p>', /style/],
    ['<p style="margin-left:9999px">x</p>', /style/],
    ['<p style="padding-top:300px">x</p>', /style/],
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

  it("strips bidi override characters", () => {
    expect(sanitizeAgentHtml("<p>a‮b⁦c⁩d‬e</p>")).toBe("<p>abcde</p>");
  });
});

describe("user HTML: what the card marks and refuses", () => {
  it("shows images in the signature and quote", () => {
    expect(cardBodyFromHtml(PROBES.altQuote).quotedHistory).toContain(
      `[image: ${sentinel("altQuote")} pay https://x.test/pay.png]`,
    );
    expect(cardBodyFromHtml(PROBES.altSignature).signature).toContain(
      `[image: ${sentinel("altSignature")} cid:sig1]`,
    );
  });

  it.each([
    "conditionalComment",
    "conditionalSpaced",
    "conditionalEndVariant",
    "conditionalUpper",
  ])("shows Outlook-only content (%s) as a notice and refuses a body edit", (name) => {
    const card = cardBodyFromHtml(PROBES[name]);

    expect(card.notices).toContain(`[shown only in Outlook: ${sentinel(name)}`);
    expect(card.body).not.toContain(sentinel(name));
    expect(rebuildHtmlWithEditedBody(PROBES[name], "Hello")).toBeNull();
  });

  it.each([
    ["cssAfter", `.x::after{content:"${sentinel("cssAfter")}"}`],
    [
      "cssContentEscape",
      `.x::after{\\63 ontent:"${sentinel("cssContentEscape")}"}`,
    ],
    [
      "cssImport",
      `@import url(https://evil.test/${sentinel("cssImport")}.css);`,
    ],
    ["cssLink", `https://evil.test/${sentinel("cssLink")}.css`],
  ])("shows the style sheet of %s as a notice, not in the body", (name, css) => {
    const card = cardBodyFromHtml(PROBES[name]);

    expect(card.notices).toContain(`[style sheet: ${css}]`);
    expect(card.body).not.toMatch(MARKERS);
    expect(hasHiddenText(PROBES[name])).toBe(false);
  });

  it("keeps the authored part's style sheet after a body edit, without the notice", () => {
    const card = cardBodyFromHtml(PROBES.cssAfter);
    const html =
      rebuildHtmlWithEditedBody(
        PROBES.cssAfter,
        card.body.replace("Hi", "Yo"),
      ) ?? "";

    expect(html).toContain(
      `<style>.x::after{content:"${sentinel("cssAfter")}"}</style>`,
    );
    expect(html).toContain("Yo Bob");
    expect(html).not.toMatch(MARKERS);
  });

  it("edits an Outlook-desktop draft with a head style sheet, showing the CSS", () => {
    const head =
      '<html><head><meta charset="utf-8"><style>p.MsoNormal{margin:0in;font-size:11pt}</style><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--></head>';
    const original = `${head}<body lang=EN-US><div class=WordSection1><p class=MsoNormal>Hello Bob</p></div></body></html>`;

    const card = cardBodyFromHtml(original);
    const html =
      rebuildHtmlWithEditedBody(original, card.body.replace("Bob", "Rob")) ??
      "";

    expect(card.body).toBe("Hello Bob");
    expect(card.notices).toContain(
      "[style sheet: p.MsoNormal{margin:0in;font-size:11pt}]",
    );
    expect(html.startsWith(head)).toBe(true);
    expect(html).toContain("Hello Rob");
    expect(html).not.toMatch(MARKERS);
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
    const html =
      rebuildHtmlWithEditedBody(
        original,
        card.body.replace("noted", "*done*"),
      ) ?? "";

    expect(card.quotedHistory).toContain("[style sheet: .hero");
    expect(card.quotedHistory).toContain(
      "[shown only in Outlook: Outlook only]",
    );
    expect(html).toContain("<em>done</em>");
    expect(html.endsWith(quote)).toBe(true);
  });

  // An edit that adds a tag (bold, a list, a link) a style sheet has a rule
  // for would hide or restyle text that rule did not touch before.
  it.each([
    [
      "a head rule",
      "<html><head><style>strong{display:none}</style></head><body><div>Hi Bob</div></body></html>",
    ],
    [
      "a quoted rule",
      '<div dir="ltr">Hi Bob</div><div class="gmail_quote"><style>strong{font-size:0}</style>old</div>',
    ],
    [
      "a grouped rule",
      "<style>td, strong , em{font-size:0}</style><div>Hi Bob</div>",
    ],
  ])("refuses an edit that a style sheet would restyle (%s)", (_name, html) => {
    expect(rebuildHtmlWithEditedBody(html, "Hi **Rob**")).toBeNull();
  });

  it("edits a Gmail reply quoting a newsletter with a p rule, sending divs", () => {
    const { html: original } = createReplyContent({
      textContent: "Thanks, noted\n\nSee you Monday",
      message: {
        headers: {
          from: "News <news@example.com>",
          to: "me@example.com",
          subject: "Weekly",
          date: "Mon, 2 Nov 2026 10:00:00 +0000",
        },
        textPlain: "Big news",
        textHtml:
          "<html><head><style>p{color:red}</style></head><body><p>Big news</p></body></html>",
      },
    });
    const card = cardBodyFromHtml(original);

    const html =
      rebuildHtmlWithEditedBody(original, card.body.replace("noted", "done")) ??
      "";
    const authored = html.slice(0, html.indexOf('<div class="gmail_quote'));

    expect(authored).toContain(
      "<div>Thanks, done</div><div><br></div><div>See you Monday</div>",
    );
    expect(authored).not.toContain("<p>");
  });

  it("keeps <p> blocks for an Outlook (p-based) body", () => {
    const original =
      "<style>p{margin:0}</style><p class=MsoNormal>Hi Bob</p><p class=MsoNormal>Thanks</p>";

    expect(rebuildHtmlWithEditedBody(original, "Hi Rob\n\nThanks")).toContain(
      "<p>Hi Rob</p>\n<p>Thanks</p>",
    );
  });

  it("allows a plain edit under a quoted p rule, as divs", () => {
    const html =
      rebuildHtmlWithEditedBody(PROBES.quoteStyleHidesP, "Hi Rob") ?? "";

    expect(html.startsWith('<div dir="ltr"><div>Hi Rob</div></div>')).toBe(
      true,
    );
  });

  it("allows an edit when the style sheet only targets tags already there", () => {
    const html = "<style>p{margin:0}</style><p>Hi Bob</p>";

    expect(rebuildHtmlWithEditedBody(html, "Hi Rob")).toContain("Hi Rob");
  });

  it("shows hidden text in the signature without blocking a body edit", () => {
    expect(
      rebuildHtmlWithEditedBody(PROBES.hiddenInSignature, "Hello"),
    ).toContain("Hello");
  });

  it("shows a style sheet inside the quote under the quoted history", () => {
    expect(cardBodyFromHtml(PROBES.cssInQuote).quotedHistory).toContain(
      `[style sheet: .x::after{content:"${sentinel("cssInQuote")}"}]`,
    );
  });

  it.each([
    [
      "backgroundImage",
      `[background image: https://x.test/${sentinel("backgroundImage")}.png]`,
    ],
    [
      "backgroundAttribute",
      `[background image: https://x.test/${sentinel("backgroundAttribute")}.png]`,
    ],
    ["input", `[form field: ${sentinel("input")} TO 123]`],
    ["iframeSrcdoc", `[embedded page: ${sentinel("iframeSrcdoc")}]`],
    [
      "displayNone",
      `[hidden in the email: Also wire ${sentinel("displayNone")}]`,
    ],
  ])("shows %s as a notice and refuses a body edit", (name, marker) => {
    const card = cardBodyFromHtml(PROBES[name]);

    expect(card.notices).toContain(marker);
    expect(card.body).not.toMatch(MARKERS);
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
});

function sentinel(name: string) {
  return `ZQX${name}QZ`;
}

function shown(card: CardBody) {
  return normalize(
    [card.body, card.signature, card.quotedHistory, card.notices].join(" "),
  );
}

function expectCovers(card: CardBody, html: string) {
  const text = shown(card);
  for (const token of visibleTokens(html))
    expect(text, `card is missing "${token}"`).toContain(normalize(token));
}

// What a recipient could see in this HTML, found independently of the
// implementation: text, image alt and src, comments that hold "[if" (any
// spelling Outlook might honour), style sheets (they can add text), form
// values, embedded pages and background images.
function visibleTokens(html: string): string[] {
  const tokens: string[] = [];
  for (const match of html.matchAll(/<!--([\s\S]*?)-->/g))
    if (/\[\s*if/i.test(match[1]))
      tokens.push(...textWords(match[1].replace(/<?!?\[[^\]]*\]>?/g, " ")));

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

// Markdown escapes, heading case and bidi controls are presentation.
function normalize(text: string) {
  return text.replace(/\\/g, "").replace(/[‪-‮⁦-⁩]/g, "").toLowerCase();
}
