import "server-only";
import EmailReplyParser from "email-reply-parser";
import { convert } from "html-to-text";
import type { ParsedMessage } from "@/utils/types";
import { removeExcessiveWhitespace, truncate } from "@/utils/string";
import { env } from "@/env";
import { SafeError } from "@/utils/error";

export function parseReply(plainText: string) {
  const parser = new EmailReplyParser().read(plainText);
  const result = parser.getVisibleText();
  return result;
}

// important to do before processing html emails
// this will cut down an email from 100,000 characters to 1,000 characters in some cases
function htmlToText(html: string, removeLinks = true, removeImages = true) {
  const text = convert(html, {
    wordwrap: 130,
    // this removes links and images.
    // might want to change this in the future if we're searching for links like Unsubscribe
    selectors: [
      ...(removeLinks
        ? [{ selector: "a", options: { ignoreHref: true } }]
        : []),
      ...(removeImages ? [{ selector: "img", format: "skip" }] : []),
    ],
  });

  return text;
}

export function getEmailClient(messageId: string) {
  if (messageId.includes("mail.gmail.com")) return "gmail";
  if (messageId.includes("we.are.superhuman.com")) return "superhuman";
  if (messageId.includes("mail.shortwave.com")) return "shortwave";

  // take part after @ and remove final >
  const emailClient = messageId.split("@")[1].split(">")[0];
  return emailClient;
}

const FORWARDED_CONTENT_PATTERNS = [
  // Gmail style
  /(?:\r?\n|\r)?(?:-{3,}|_{3,})\s*Forwarded message\s*(?:-{3,}|_{3,})/i,
  // Simple forward markers
  /(?:\r?\n|\r)?(?:-{3,}|_{3,})\s*Forward(?:ed)?(?:\s*message)?(?:-{3,}|_{3,})/i,
  // Email headers
  /(?:\r?\n|\r)?From:[\s\S]*?Subject:/m,
  // iOS/Mac style, at the start of a line
  /^[^\S\r\n\u2028\u2029]*Begin forwarded message:/im,
  // Outlook style: a separator line, not the phrase inside a sentence
  // ([^\S\r\n\u2028\u2029] also covers the non-breaking spaces HTML-to-text
  // leaves; /m treats U+2028/U+2029 as line starts, so they are left out or a
  // run of them would make the scan quadratic)
  /^[^\S\r\n\u2028\u2029]*(?:[-_]+[^\S\r\n\u2028\u2029]*)?Original Message(?:[^\S\r\n\u2028\u2029]*[-_]+)?[^\S\r\n\u2028\u2029]*$/im,
];

function removeForwardedContent(text: string): string {
  // Cut at whichever marker comes first: an Outlook separator is followed by
  // a From/Sent/To/Subject block, and cutting at that block would leave the
  // separator line behind.
  const markerIndexes = FORWARDED_CONTENT_PATTERNS.map((pattern) =>
    text.search(pattern),
  ).filter((index) => index !== -1);
  if (markerIndexes.length === 0) return text;

  return removeExcessiveWhitespace(text.slice(0, Math.min(...markerIndexes)));
}

export type EmailToContentOptions = {
  maxLength?: number;
  extractReply?: boolean;
  removeForwarded?: boolean;
};

export function emailToContent(
  email: Pick<ParsedMessage, "textHtml" | "textPlain" | "snippet">,
  {
    maxLength = 2000,
    extractReply = false,
    removeForwarded = false,
  }: EmailToContentOptions = {},
): string {
  let content = "";

  if (email.textHtml) {
    content = htmlToText(email.textHtml);
  } else if (email.textPlain) {
    content = email.textPlain;
  } else if (email.snippet) {
    content = email.snippet;
  }

  if (extractReply) {
    content = parseReply(content);
  }

  if (removeForwarded) {
    content = removeForwardedContent(content);
  }

  content = removeExcessiveWhitespace(content);

  return maxLength ? truncate(content, maxLength) : content;
}

export function convertEmailHtmlToText({
  htmlText,
  includeLinks = true,
  wordwrap = 130,
  uppercaseHeadings = true,
}: {
  htmlText: string;
  includeLinks?: boolean;
  wordwrap?: number | false;
  uppercaseHeadings?: boolean;
}): string {
  const plainText = convert(htmlText, {
    wordwrap,
    selectors: [
      ...(uppercaseHeadings ? [] : KEEP_HEADING_CASE_SELECTORS),
      {
        selector: "a",
        options: includeLinks
          ? { hideLinkHrefIfSameAsText: true } // Keep link URLs: "Text [URL]"
          : { ignoreHref: true }, // Remove links entirely: "Text"
      },
      { selector: "img", format: "skip" },
    ],
  });

  return plainText;
}

/**
 * Ensures email sending is enabled. Throws an error if disabled.
 * @throws {SafeError} If email sending is disabled
 */
export function ensureEmailSendingEnabled(): void {
  // In standalone builds, runtime env vars need to be read from process.env
  // The env object is validated at build time and may not reflect runtime values
  const processEnvValue = process.env.NEXT_PUBLIC_EMAIL_SEND_ENABLED;
  const envValue = env.NEXT_PUBLIC_EMAIL_SEND_ENABLED;
  const isEnabled = processEnvValue === "true" || envValue === true;

  console.log("[ensureEmailSendingEnabled] Debug:", {
    processEnvValue,
    envValue,
    isEnabled,
  });

  if (!isEnabled) {
    throw new SafeError(
      `Email sending is disabled. Set NEXT_PUBLIC_EMAIL_SEND_ENABLED=true to enable. (process.env=${processEnvValue}, env=${envValue})`,
    );
  }
}

const KEEP_HEADING_CASE_SELECTORS = [
  ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
    selector,
    options: { uppercase: false },
  })),
  { selector: "table", options: { uppercaseHeaderCells: false } },
];
