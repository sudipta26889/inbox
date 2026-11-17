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
  afterHtmlStyle:
    '<html><body><p>Hi Bob</p></body></html><style>body::after{content:"@S@"}</style>',
  afterHtmlLink:
    '<html><body><p>Hi Bob</p></body></html><link rel="stylesheet" href="https://evil.test/@S@.css">',
  afterHtmlConditional:
    "<html><body><p>Hi Bob</p></body></html><!--[if mso]><p>@S@</p><![endif]-->",
  bodyBackground:
    '<html><body background="https://x.test/@S@.png"><p>Hi Bob</p></body></html>',
  bodyBackgroundStyle:
    '<html><body style="background-image:url(https://x.test/@S@.png)"><p>Hi Bob</p></body></html>',
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
// Bodies a reviewer must be able to edit on the card.
const EDITABLE = [
  "afterHtmlStyle",
  "afterHtmlLink",
  "afterHtmlConditional",
  "middle",
  "cssAfter",
  "cssImport",
  "cssLink",
  "quoteStyleHidesP",
  "gmailWebSignature",
  "outlookDesktop",
];
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

  it.each(paths)("%s HTML: %s", (path, name, html) => {
    const card = cardBodyFromHtml(html);
    const edited = card.body.replace(/[A-Za-z]{2,}/, "Yo");

    const sent = rebuildHtmlWithEditedBody(html, edited);
    if (path === "user" && EDITABLE.includes(name))
      expect(sent, `${name} must stay editable`).not.toBeNull();
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

  it.each([
    ["a font list with a function", "font-family:x(1)"],
    ["a near-white colour", "color:#fefefe"],
    ["white by name", "color:white"],
    ["near-white rgb", "color:rgb(250, 250, 250)"],
    ["light hsl", "color:hsl(0, 0%, 95%)"],
    ["a colour with alpha", "color:rgba(0, 0, 0, 0.5)"],
    ["an 8-digit hex colour", "color:#000000aa"],
    ["an unknown colour name", "color:notacolour"],
    ["an !important size", "font-size:12px !important"],
    ["a size keyword", "font-size:small"],
    ["a size below 8px", "font-size:7px"],
    ["a zero line height", "line-height:0"],
    ["a negative margin", "margin:-4px"],
    ["a margin over 200px", "margin:0 0 0 300px"],
  ])("drops %s", (_name, declaration) => {
    expect(sanitizeAgentHtml(`<p style="${declaration}">x</p>`)).toBe(
      "<p>x</p>",
    );
  });

  it.each([
    'font-family:Aptos, Aptos_EmbeddedFont, "Segoe UI", sans-serif',
    "font-size:11pt",
    "color:#1f1f1f",
    "color:rgb(0, 0, 0)",
    "color:hsl(210, 50%, 40%)",
    "color:navy",
    "line-height:1.5",
    "margin:0in 0in 8pt",
  ])("keeps %s", (declaration) => {
    expect(
      load(sanitizeAgentHtml(`<p style='${declaration}'>x</p>`))("p").attr(
        "style",
      ),
    ).toBe(declaration.replace(/\s*:\s*/, ":"));
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

  it("drops a text-adding style sheet from an edited send, without the notice", () => {
    const card = cardBodyFromHtml(PROBES.cssAfter);
    const html =
      rebuildHtmlWithEditedBody(
        PROBES.cssAfter,
        card.body.replace("Hi", "Yo"),
      ) ?? "";

    expect(html).not.toContain("<style");
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
    // The edited send carries no style sheet or Outlook-only block.
    expect(html.startsWith('<html><head><meta charset="utf-8"></head>')).toBe(
      true,
    );
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
    // The quote is kept as it was, minus its style sheet and Outlook-only block.
    expect(
      html.endsWith(
        quote
          .replace(/<style>[\s\S]*?<\/style>/, "")
          .replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/, ""),
      ),
    ).toBe(true);
  });

  // Style sheets apply to the whole email and may match the edit's new
  // structure. Unless every selector is a plain one, an edited send carries
  // no style sheet at all: formatting may go, text never gets hidden.
  it.each([
    [
      "an attribute and child combinator",
      "<style>[dir] > *{display:none}</style>",
      "Hi Rob",
    ],
    ["a CSS escape", "<style>d\\69 v{display:none}</style>", "Hi Rob"],
    ["a child combinator", "<style>p > *{display:none}</style>", "Hi **Rob**"],
    [
      "a :not() selector",
      "<style>p:not(.MsoNormal){display:none}</style>",
      "Hi Rob",
    ],
    [
      "a rule for a tag the edit adds",
      "<style>strong{display:none}</style>",
      "Hi **Rob**",
    ],
    ["@import", "<style>@import url(https://e.test/a.css);</style>", "Hi Rob"],
    [
      "a linked sheet",
      '<link rel="stylesheet" href="https://e.test/a.css">',
      "Hi Rob",
    ],
  ])("drops every style sheet from an edited send with %s", (_name, sheet, edit) => {
    const quote = `<div class="gmail_quote">${sheet}<p class="MsoNormal">old</p></div>`;
    for (const original of [
      `<div dir="ltr">Hi Bob</div>${quote}`,
      `<html><head>${sheet}</head><body><p class="MsoNormal">Hi Bob</p></body></html>`,
    ]) {
      const sent = rebuildHtmlWithEditedBody(original, edit) ?? "";

      expect(sent).toContain("Rob");
      expect(sent).not.toMatch(/<style|<link/i);
    }
  });

  it.each([
    [
      "a nested rule",
      "<style>.WordSection1{ strong{display:none} }</style><div class=WordSection1><p class=MsoNormal>Hi Bob</p></div>",
      "Hi **Rob**",
      "<strong>Rob</strong>",
    ],
    [
      "a rule on Gmail's class",
      '<style>.gmail_default{display:none}</style><div dir="ltr"><div class="gmail_default">Hi Bob</div></div>',
      "Hi Rob",
      "Hi Rob",
    ],
    [
      "a remote font",
      "<style>@font-face{font-family:Spy;src:url(https://e.test/f.woff)} p{font-family:Spy}</style><p>Hi Bob</p>",
      "Hi Rob",
      "Hi Rob",
    ],
  ])("an edited send with %s carries no style sheet or copied class", (_name, original, edit, text) => {
    const sent = rebuildHtmlWithEditedBody(original, edit) ?? "";

    expect(sent).toContain(text);
    expect(sent).not.toMatch(/<style|@font-face|<link|class=/i);
  });

  // Nothing from a style sheet is ever taken onto edited text, and an
  // attribute value that is not a clean colour or font name brings nothing.
  it.each([
    [
      "a font colour that injects a declaration",
      '<p><font color="red;font-size:0">Hi Bob</font></p>',
    ],
    [
      "a font face that injects a declaration",
      '<p><font face="arial;display:none">Hi Bob</font></p>',
    ],
    [
      "a print-only white class rule",
      "<style>@media print{ .MsoNormal{color:#ffffff} }</style><p class=MsoNormal>Hi Bob</p>",
    ],
    [
      "a class rule on the first block only",
      "<style>.MsoNormal{color:#ffffff}</style><p class=MsoNormal>intro</p><p>Hi Bob visible</p>",
    ],
    [
      "an !important zero size in a class rule",
      "<style>.MsoNormal{color:red;font-size:0 !important}</style><p class=MsoNormal>Hi Bob</p>",
    ],
  ])("an edit of %s sends visible text with no hiding style", (_name, original) => {
    const card = cardBodyFromHtml(original);
    const sent =
      rebuildHtmlWithEditedBody(original, card.body.replace("Bob", "Rob")) ??
      "";

    expect(sent).toContain("Rob");
    expect(sent).not.toMatch(/font-size:0|display:none|#fff|style=|class=/i);
  });

  it("keeps a font colour and face that are clean", () => {
    const original =
      '<div dir="ltr"><font color="#0b5394" face="arial, sans-serif">Hello team</font></div>';

    expect(rebuildHtmlWithEditedBody(original, "Hi team")).toContain(
      'style="color:#0b5394;font-family:arial, sans-serif"',
    );
  });

  it("leaves an unedited send untouched by the style sheet rule", () => {
    // Nothing is rebuilt when the body is unchanged: the gate sends the
    // original HTML, sheets and all (tested in send-approval.test.ts).
    expect(
      cardBodyFromHtml("<style>[dir]>*{color:red}</style><p>Hi</p>").body,
    ).toBe("Hi");
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

  it.each([
    "afterHtmlStyle",
    "afterHtmlLink",
    "afterHtmlConditional",
  ])("shows what follows </html> (%s) and strips it from an edited send", (name) => {
    const card = cardBodyFromHtml(PROBES[name]);
    const sent =
      rebuildHtmlWithEditedBody(
        PROBES[name],
        card.body.replace("Bob", "Rob"),
      ) ?? "";

    expect(card.notices).toContain(sentinel(name));
    expect(sent).toContain("Hi Rob");
    expect(sent).not.toContain(sentinel(name));
  });

  it.each([
    "bodyBackground",
    "bodyBackgroundStyle",
  ])("shows the body's background image (%s) as a notice", (name) => {
    expect(cardBodyFromHtml(PROBES[name]).notices).toContain(
      `[background image: https://x.test/${sentinel(name)}.png]`,
    );
  });

  it.each([
    ["a text field", '<p>Hi</p><input type="text" name="acct">'],
    ["a textarea", "<p>Hi</p><textarea>x</textarea>"],
    ["a select", "<p>Hi</p><select><option>x</option></select>"],
    ["a form", '<form action="https://e.test"><p>Hi</p></form>'],
    ["an iframe", '<p>Hi</p><iframe src="https://e.test"></iframe>'],
  ])("refuses a body edit when the authored part has %s", (_name, html) => {
    expect(rebuildHtmlWithEditedBody(html, "Hello")).toBeNull();
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
