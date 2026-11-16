import { describe, expect, it } from "vitest";
import { createReplyContent } from "@/utils/gmail/reply";
import { load } from "cheerio";
import { renderReplyBodyHtml } from "@/utils/email/reply-body-html";
import { createOutlookReplyContent } from "@/utils/outlook/reply";
import { convertOutgoingEmailHtmlToText } from "@/utils/mail";
import {
  cardBodyFromHtml,
  hasHiddenText,
  rebuildHtmlWithEditedBody,
} from "./card-body";

const SIGNATURE =
  '<div class="gmail_signature" data-smartmail="gmail_signature"><b>Sudipta</b><br><a href="https://grihatek.com">grihatek.com</a></div>';
const QUOTE =
  '<div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon, Bob wrote:<br></div><blockquote class="gmail_quote"><p>Earlier <i>message</i></p></blockquote></div>';
const AUTHORED =
  '<div dir="ltr"><p>Hello <strong>team</strong>, see <a href="https://example.com/doc">the doc</a>.</p><ul><li>first</li><li>second</li></ul></div>';
const HTML = `<html><body>${AUTHORED}${SIGNATURE}${QUOTE}</body></html>`;

describe("cardBodyFromHtml", () => {
  it("shows the authored part as Markdown and the rest as text", () => {
    const card = cardBodyFromHtml(HTML);

    expect(card.body).toContain("**team**");
    expect(card.body).toContain("[the doc](https://example.com/doc)");
    expect(card.body).toMatch(/^- +first$/m);
    expect(card.body).not.toContain("Sudipta");
    expect(card.body).not.toContain("Earlier");
    expect(card.signature).toContain("Sudipta");
    expect(card.quotedHistory).toContain("Earlier message");
  });

  it("omits signature and quote when there are none", () => {
    const card = cardBodyFromHtml("<p>Just <em>this</em></p>");

    expect(card).toEqual({ body: "Just *this*" });
  });
});

describe("rebuildHtmlWithEditedBody", () => {
  it("keeps formatting, signature and quote after a one-word edit", () => {
    const edited = cardBodyFromHtml(HTML).body.replace("team", "everyone");

    const html = rebuildHtmlWithEditedBody(HTML, edited);

    expect(html).toContain("<strong>everyone</strong>");
    expect(html).toContain('<a href="https://example.com/doc">the doc</a>');
    expect(html).toMatch(/<ul>\s*<li>first<\/li>\s*<li>second<\/li>\s*<\/ul>/);
    expect(html).toContain(`${SIGNATURE}${QUOTE}</body></html>`);
    expect(html.startsWith("<html><body>")).toBe(true);
  });

  it("escapes raw HTML and drops script links in the edited Markdown", () => {
    const html = rebuildHtmlWithEditedBody(
      "<p>Hi</p>",
      'Hi <script>alert(1)</script> <img src=x onerror="alert(2)">\n\n<div>raw</div>\n\n[click](javascript:alert(3))',
    );

    expect(html).not.toMatch(/<script|<img|<div>|javascript:/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;div&gt;raw&lt;/div&gt;");
    expect(html).toContain("click");
  });

  it("keeps a Gmail reply's quote byte-identical", () => {
    const { html: original } = createReplyContent({
      textContent: "Thanks, **noted**",
      message: quotedMessage,
    });
    const quote = original.slice(original.indexOf('<div class="gmail_quote'));

    const html = rebuildHtmlWithEditedBody(original, "Thanks, *changed*");

    expect(html).toContain("<em>changed</em>");
    expect(html.endsWith(quote)).toBe(true);
  });

  it("keeps an Outlook reply's header and quote byte-identical", () => {
    const { html: original } = createOutlookReplyContent({
      textContent: "Thanks",
      message: quotedMessage,
    });
    const quote = original.slice(original.indexOf('<div style="border-top'));
    expect(cardBodyFromHtml(original)).toMatchObject({ body: "Thanks" });

    const html = rebuildHtmlWithEditedBody(original, "Thanks a lot");

    expect(html).toContain("Thanks a lot");
    expect(html.endsWith(quote)).toBe(true);
  });

  it("keeps an Outlook client reply header (divRplyFwdMsg) byte-identical", () => {
    const quote =
      '<div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Bob</div><div>Old</div>';
    const original = `<html><head><meta charset="utf-8"></head><body><div>Hi</div>${quote}</body></html>`;

    const html = rebuildHtmlWithEditedBody(original, "Hello");

    expect(html).toBe(
      `<html><head><meta charset="utf-8"></head><body><div><p>Hello</p></div>${quote}</body></html>`,
    );
  });
});

describe("edits that the Markdown round trip can't carry", () => {
  it("keeps an inline cid image through a one-word edit", () => {
    const original =
      '<p>See the chart:</p><p><img src="cid:ii_abc" alt="chart"></p><p>Thanks</p>';
    const edited = cardBodyFromHtml(original).body.replace("Thanks", "Cheers");

    const html = rebuildHtmlWithEditedBody(original, edited);

    expect(html).toContain('<img src="cid:ii_abc" alt="chart">');
    expect(html).toContain("Cheers");
  });

  it("does not render an image URL that was not in the original", () => {
    const html = rebuildHtmlWithEditedBody(
      "<p>Hi</p>",
      "Hi ![x](https://tracker.test/pixel.png)",
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("tracker.test");
  });

  it.each([
    ["a table", "<p>Rates</p><table><tr><td>1</td></tr></table>"],
    ["one coloured word", '<p>Hi <span style="color:red">urgent</span></p>'],
    [
      "paragraphs in different fonts",
      '<p style="font-family:Arial">One</p><p style="font-family:Georgia">Two</p>',
    ],
    ["a background colour", '<p style="background-color:yellow">Hi</p>'],
    [
      "positioning",
      '<p style="position:relative;top:2px">Hi</p><p style="position:relative;top:2px">Two</p>',
    ],
    ["a font size tag", '<p><font size="4">Hi</font></p>'],
    ["a style element", "<style>p{color:red}</style><p>Hi</p>"],
  ])("refuses a body edit on %s", (_name, original) => {
    expect(rebuildHtmlWithEditedBody(original, "Changed")).toBeNull();
  });

  it("keeps new Outlook's font style on every paragraph after an edit", () => {
    const font =
      "font-family: Aptos, Aptos_EmbeddedFont, Calibri, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);";
    const original = `<div class="elementToProof" style="${font}">Hi Bob,</div><div class="elementToProof" style="${font}"><br></div><div class="elementToProof" style="${font}">The report is ready.</div>`;
    const edited = cardBodyFromHtml(original).body.replace("ready", "done");

    const html = rebuildHtmlWithEditedBody(original, edited) ?? "";

    expect(html).toContain("The report is done.");
    const blocks = load(html, null, false).root().children().toArray();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(load(block).root().children().first().attr("style")).toContain(
        "font-family:Aptos, Aptos_EmbeddedFont, Calibri, Helvetica, sans-serif",
      );
    }
  });

  it("keeps Gmail's coloured text after an edit", () => {
    const original =
      '<div dir="ltr"><font color="#0b5394" face="arial, sans-serif">Hello team, all set.</font></div>';
    const edited = cardBodyFromHtml(original).body.replace("set", "done");

    const html = rebuildHtmlWithEditedBody(original, edited) ?? "";

    expect(html).toBe(
      '<div dir="ltr"><p style="color:#0b5394;font-family:arial, sans-serif">Hello team, all done.</p></div>',
    );
  });

  it("allows edits inside a styled wrapper, which is kept as it was", () => {
    const { html: original } = createOutlookReplyContent({
      textContent: "Thanks",
      message: quotedMessage,
    });
    const wrapper = original.slice(0, original.indexOf(">") + 1);

    const html = rebuildHtmlWithEditedBody(original, "Thanks a lot") ?? "";

    expect(html.startsWith(`${wrapper}<p>Thanks a lot</p></div>`)).toBe(true);
  });

  it("shows hidden text on the card, marked, and refuses a body edit", () => {
    const original =
      '<div>Hi Bob</div><div style="display:none">Also wire 5000 to acct 123</div>';

    const card = cardBodyFromHtml(original);

    expect(card.body).toContain("Also wire 5000");
    expect(card.body).toContain(
      "[hidden in the email: Also wire 5000 to acct 123]",
    );
    expect(rebuildHtmlWithEditedBody(original, "Hi Rob")).toBeNull();
  });

  it.each([
    ["visibility:hidden", '<span style="visibility:hidden">secret</span>'],
    ["font-size:0", '<span style="font-size:0">secret</span>'],
    ["opacity:0", '<span style="opacity:0">secret</span>'],
    [
      "text coloured like its background",
      '<span style="color:#fff;background-color:#FFF">secret</span>',
    ],
    ["the hidden attribute", "<span hidden>secret</span>"],
  ])("marks text hidden by %s and refuses a body edit", (_name, hidden) => {
    const original = `<p>Hi ${hidden}</p>`;

    expect(cardBodyFromHtml(original).body).toContain(
      "[hidden in the email: secret]",
    );
    expect(rebuildHtmlWithEditedBody(original, "Hi")).toBeNull();
  });

  it.each([
    ["url(", "font-family:url(https://x.test/a)"],
    ["expression", "color:expression(alert(1))"],
    ["a comment", "color:red/*x*/"],
    ["a backslash", "font-family:\\61rial"],
    ["a negative number", "margin-left:-9999px"],
    ["a font size below 8px", "font-size:6px"],
    ["a font size below 8px in pt", "font-size:5pt"],
  ])("refuses a body edit on a style with %s", (_name, style) => {
    expect(
      rebuildHtmlWithEditedBody(`<p style="${style}">Hi</p>`, "Hello"),
    ).toBeNull();
  });
});

describe("balanced output", () => {
  it("keeps the edited text inside Gmail's dir=ltr wrapper", () => {
    const original = `<div dir="ltr"><p>Hello</p>${SIGNATURE}</div>${QUOTE}`;

    const html = rebuildHtmlWithEditedBody(original, "Hi there") ?? "";

    expect(html).toBe(
      `<div dir="ltr"><p>Hi there</p>${SIGNATURE}</div>${QUOTE}`,
    );
    expect(html.match(/<div/g)?.length).toBe(html.match(/<\/div>/g)?.length);
  });

  it("keeps a head with styles when the body tag is implied", () => {
    const original =
      "<html><head><style>p{margin:0}</style></head><p>Hello</p></html>";

    const html = rebuildHtmlWithEditedBody(original, "Hi") ?? "";

    expect(html).toBe(
      "<html><head><style>p{margin:0}</style></head><p>Hi</p></html>",
    );
  });

  it("keeps the wrapper's dir when a P.S. follows the signature", () => {
    const original = `<div dir="rtl"><p>Hello</p><div class="gmail_signature">Me</div><p>P.S. today</p></div>${QUOTE}`;

    const html =
      rebuildHtmlWithEditedBody(original, "Hi\n\nMe\n\nP.S. now") ?? "";

    expect(html.startsWith('<div dir="rtl"><p>Hi</p>')).toBe(true);
    expect(html.endsWith(`</div>${QUOTE}`)).toBe(true);
  });

  it("splits off a Gmail-web signature with its '-- ' prefix", () => {
    const signature =
      '<span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr"><span style="color:rgb(102,102,102)">Me</span></div></div>';
    const original = `<div dir="ltr"><div>Hello Bob</div><div><br></div><div>Thanks</div><br clear="all"><div><br></div>${signature}</div>`;

    const card = cardBodyFromHtml(original);
    const html = rebuildHtmlWithEditedBody(original, "Hello Rob\n\nThanks");

    expect(card.body).toBe("Hello Bob\n\nThanks");
    expect(card.signature).toBe("--\n\nMe");
    expect(html).toContain("Hello Rob");
    expect(html?.endsWith(`${signature}</div>`)).toBe(true);
  });

  it("keeps blank lines of an AI reply as paragraphs", () => {
    const original = renderReplyBodyHtml(
      "Hi Bob,\n\nPara two line1\nline2\n\nThanks,\nMe",
    );
    const card = cardBodyFromHtml(original);
    expect(card.body).toBe("Hi Bob,\n\nPara two line1\nline2\n\nThanks,\nMe");

    const html =
      rebuildHtmlWithEditedBody(original, card.body.replace("Bob", "Rob")) ??
      "";

    expect(html).toBe(
      "<p>Hi Rob,</p>\n<p>Para two line1<br>line2</p>\n<p>Thanks,<br>Me</p>",
    );
  });

  it("keeps a P.S. after the signature in the editable body", () => {
    const card = cardBodyFromHtml(
      `<p>Hello</p>${SIGNATURE}<p>P.S. wire it today</p>`,
    );

    expect(card.body).toContain("P.S. wire it today");
  });
});

describe("Outlook client quote headers", () => {
  const wordHeader = (color: string) =>
    `<div style="border:none;border-top:solid ${color} 1.0pt;padding:3.0pt 0in 0in 0in"><p class=MsoNormal><b>From:</b> Bob &lt;bob@x.com&gt;<br><b>Sent:</b> Monday<br><b>To:</b> Me<br><b>Subject:</b> Q</p></div><p class=MsoNormal>Old text</p>`;

  it.each([
    [
      "Outlook desktop",
      `<div class=WordSection1><p class=MsoNormal>Reply</p><div>${wordHeader("#E1E1E1")}</div></div>`,
      `<div>${wordHeader("#E1E1E1")}</div></div>`,
    ],
    [
      "Outlook 2010",
      `<p>Reply</p>${wordHeader("#B5C4DF")}`,
      wordHeader("#B5C4DF"),
    ],
    [
      "Outlook for Mac",
      '<p>Reply</p><div id="mail-editor-reference-message-container"><b>From:</b> Bob</div>',
      '<div id="mail-editor-reference-message-container"><b>From:</b> Bob</div>',
    ],
    [
      "Hotmail",
      '<p>Reply</p><hr id="stopSpelling">Old text',
      '<hr id="stopSpelling">Old text',
    ],
  ])("treats the %s header as quoted history", (_name, original, quote) => {
    const card = cardBodyFromHtml(original);

    expect(card.body).toBe("Reply");
    expect(card.quotedHistory).toBeTruthy();
    expect(rebuildHtmlWithEditedBody(original, "Edited")?.endsWith(quote)).toBe(
      true,
    );
  });
});

describe("every word that is sent is on the card", () => {
  it.each([
    [
      "text between the signature and the quote",
      '<p>Hi Bob</p><div class="gmail_signature">Me</div><p>WIRE 5000 TO ACCT 123</p><div class="gmail_quote">old</div>',
    ],
    [
      "text after the signature inside the wrapper, no quote",
      '<div dir="ltr">Hi Bob<div class="gmail_signature">Me</div>AFTER SIG TEXT</div>',
    ],
    [
      "text next to a lone wrapper, before the signature's parent",
      '<div>Hi Bob</div><div>WIRE 5000 TO ACCT 123<div class="gmail_signature">Me</div></div>',
    ],
    [
      "text after the closing html tag",
      "<html><body><p>Hi Bob</p></body></html>WIRE 5000 TO ACCT 123",
    ],
    [
      "text after the closing html tag with a quote",
      '<html><body><p>Hi Bob</p><div class="gmail_quote">old</div></body></html>WIRE 5000',
    ],
    [
      "text between two wrappers around the quote",
      '<div dir="ltr"><div>Hi Bob</div>WIRE 5000<div><div class="gmail_quote">old</div></div></div>',
    ],
  ])("%s", (_name, html) => {
    const card = cardBodyFromHtml(html);
    const shown = [card.body, card.signature, card.quotedHistory].join("\n");

    for (const word of convertOutgoingEmailHtmlToText(html).split(/\s+/))
      expect(shown).toContain(word);
  });
});

describe("style sheets that add text", () => {
  it.each([
    [
      "in the body",
      '<style>.x::after{content:"WIRE 5000 TO 123"}</style><p>Hi Bob</p><span class="x"></span>',
    ],
    [
      "in the head",
      '<html><head><style>.x:before { content: "WIRE 5000 TO 123" }</style></head><body><p>Hi Bob</p><span class="x"></span></body></html>',
    ],
    [
      "in the quote",
      '<p>Hi Bob</p><div class="gmail_quote"><style>.x::after{content:"WIRE 5000 TO 123"}</style>old</div>',
    ],
  ])("shows the CSS marked as hidden and refuses a body edit (%s)", (_name, html) => {
    const card = cardBodyFromHtml(html);

    expect(card.body).toContain("[hidden in the email: style sheet adds text:");
    expect(card.body).toContain("WIRE 5000 TO 123");
    expect(hasHiddenText(html)).toBe(true);
    expect(rebuildHtmlWithEditedBody(html, "Hi Rob")).toBeNull();
  });

  it("leaves a style sheet without content: alone", () => {
    const html =
      "<html><head><style>p{margin:0}</style></head><body><p>Hi</p></body></html>";

    expect(cardBodyFromHtml(html).body).toBe("Hi");
  });
});

const quotedMessage = {
  headers: {
    from: "Bob <bob@example.com>",
    to: "me@example.com",
    subject: "Q",
    date: "Mon, 2 Nov 2026 10:00:00 +0000",
  },
  textPlain: "Earlier message",
  textHtml: "<p>Earlier <b>message</b></p>",
};
