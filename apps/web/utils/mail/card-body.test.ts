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
      `<html><head><meta charset="utf-8"></head><body><p>Hello</p>${quote}</body></html>`,
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
