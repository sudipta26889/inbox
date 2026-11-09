import { describe, expect, it } from "vitest";
import { renderReplyBodyHtml, wrapSignature } from "./reply-body-html";
import { renderEmailTextWithSafeLinks } from "./render-safe-links";

const signatureTable = `<table cellpadding="0" cellspacing="0">
  <tr>
    <td>
      <div>Gmail User</div>
    </td>
  </tr>
</table>`;

describe("renderReplyBodyHtml", () => {
  it("adds line breaks to top-level text only, not inside signature tables", () => {
    const html = renderReplyBodyHtml(
      `Thanks.\n\n${wrapSignature(signatureTable)}`,
    );

    expect(html).toContain("Thanks.<br><br>");
    expect(html).toContain("<div>Gmail User</div>");
    expect(html).not.toMatch(/<(table|tbody|tr|td)[^>]*>\s*<br>/);
  });

  it("does not escape AI text a second time", () => {
    // generate-draft escapes the AI reply before appending the signature
    const escaped = renderEmailTextWithSafeLinks(
      'Q&A <b>on</b> "Friday"\nLine two',
    );

    const html = renderReplyBodyHtml(
      `${escaped}\n\n${wrapSignature("<p>Best,<br>John &amp; Co</p>")}`,
    );

    expect(html).toContain("Q&amp;A &lt;b&gt;on&lt;/b&gt;");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("&amp;lt;");
    expect(html).toContain("Line two");
    expect(html).toContain("<br>");
    expect(html).toContain("<p>Best,<br>John &amp; Co</p>");
  });

  it("escapes raw text that is not valid markup", () => {
    expect(renderReplyBodyHtml("1 < 2 & 3")).toBe("1 &lt; 2 &amp; 3");
  });
});
