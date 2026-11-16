import { describe, expect, it } from "vitest";
import { createReplyContent } from "@/utils/gmail/reply";
import { createOutlookReplyContent } from "@/utils/outlook/reply";
import { cardBodyFromHtml, rebuildHtmlWithEditedBody } from "./card-body";

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
    [
      "an inline-styled block",
      '<p>Hi <span style="color:red">urgent</span></p>',
    ],
    ["a font tag", '<p><font color="red">Hi</font></p>'],
    ["a style element", "<style>p{color:red}</style><p>Hi</p>"],
  ])("refuses a body edit on %s", (_name, original) => {
    expect(rebuildHtmlWithEditedBody(original, "Changed")).toBeNull();
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

  it("hides display:none preheaders from the card", () => {
    expect(
      cardBodyFromHtml('<div style="display:none">preheader</div><p>Hi</p>')
        .body,
    ).toBe("Hi");
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
