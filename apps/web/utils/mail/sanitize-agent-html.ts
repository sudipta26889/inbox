import "server-only";
import createDOMPurify from "dompurify";
// jsdom 26 (aliased as jsdom-cjs) keeps a fully CommonJS dependency chain;
// see utils/team-comments/content.ts.
import { JSDOM } from "jsdom-cjs";
import { typographyOnly } from "@/utils/mail/card-body";

/**
 * HTML written by an agent or model (MCP tools, A2A, the assistant, rule
 * replies) is cut down to plain email formatting before it reaches the
 * approval gate, so the card and the sent email are built from the same
 * HTML and nothing in it can show the recipient more than the card shows:
 * no style sheets, comments (Outlook conditional ones included), forms,
 * frames, background images or hiding styles.
 */
export function sanitizeAgentHtml(html: string): string {
  const window = new JSDOM("").window;
  try {
    const purifier = createDOMPurify(
      window as unknown as Parameters<typeof createDOMPurify>[0],
    );
    purifier.addHook("uponSanitizeAttribute", (node, data) => {
      const tag = node.nodeName.toLowerCase();
      const value = data.attrValue;
      const keep =
        data.attrName === "href"
          ? tag === "a" && SAFE_LINK.test(value)
          : data.attrName === "src"
            ? tag === "img" && SAFE_IMAGE.test(value)
            : data.attrName === "alt"
              ? tag === "img"
              : data.attrName === "style"
                ? STYLABLE_TAGS.has(tag) && !!typographyOnly(value)
                : data.attrName === "dir";
      if (!keep) {
        data.keepAttr = false;
        return;
      }
      if (data.attrName === "style") data.attrValue = typographyOnly(value);
    });
    return (
      purifier
        .sanitize(html, {
          ALLOWED_TAGS,
          ALLOWED_ATTR: ["href", "src", "alt", "dir", "style"],
          ALLOW_DATA_ATTR: false,
          ALLOW_ARIA_ATTR: false,
        })
        // Bidi overrides make the card and the mail client show different text.
        .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    );
  } finally {
    window.close();
  }
}

const ALLOWED_TAGS = [
  "p",
  "br",
  "div",
  "span",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "a",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "pre",
  "code",
  "img",
  "hr",
];
const STYLABLE_TAGS = new Set(["p", "div", "span"]);
const SAFE_LINK = /^(https?:|mailto:|tel:)/i;
const SAFE_IMAGE = /^(cid:|https:)/i;
