/**
 * URL Parser for Gmail and Google Calendar links
 *
 * Extracts email IDs and event IDs from Gmail/Calendar URLs to enable
 * MCP tools to work with direct copy-paste links from Gmail and Google Calendar.
 */

export interface ParsedEmailUrl {
  emailId: string;
  threadId?: string;
  type: "email";
}

export interface ParsedCalendarUrl {
  eventId: string;
  type: "calendar";
}

export type ParsedUrl = ParsedEmailUrl | ParsedCalendarUrl;

/**
 * Parse Gmail URL to extract email/thread ID
 *
 * Supports formats:
 * - https://mail.google.com/mail/u/0/?ik=...&view=pt&search=all&permthid=thread-f:1857728267523417974&simpl=msg-f:1857728267523417974
 * - https://mail.google.com/mail/u/0/#inbox/1857728267523417974
 * - https://mail.google.com/mail/u/0/#label/Important/1857728267523417974
 */
export function parseGmailUrl(input: string): ParsedEmailUrl | null {
  try {
    // If it doesn't look like a URL, return null
    if (!input.includes("mail.google.com")) {
      return null;
    }

    const url = new URL(input);

    // Extract from query parameters (search=all format)
    const permthid = url.searchParams.get("permthid");
    const simpl = url.searchParams.get("simpl");

    if (permthid || simpl) {
      // Extract the numeric ID from formats like "thread-f:1857728267523417974" or "msg-f:1857728267523417974"
      const threadMatch = permthid?.match(/thread-[a-z]:(\d+)/);
      const msgMatch =
        simpl?.match(/msg-[a-z]:(\d+)/) || simpl?.match(/msg-[a-z]:r(\w+)/);

      const threadId = threadMatch?.[1];
      const emailId = msgMatch?.[1] || threadId;

      if (emailId) {
        return {
          type: "email",
          emailId,
          threadId: threadId || undefined,
        };
      }
    }

    // Extract from hash fragment (#inbox/ID or #label/Name/ID)
    const hash = url.hash;
    if (hash) {
      // Check if this is a search URL (not directly convertible to API ID)
      if (hash.includes("#search/")) {
        // Search URLs like #search/star+health/FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF
        // The hash ID is not directly usable with Gmail API
        // Return null so the caller knows this is not a direct message link
        return null;
      }

      // Match patterns like #inbox/1234567890 or #label/Important/1234567890
      // Accept both hex IDs (lowercase) and base64url IDs (mixed case)
      const hashMatch = hash.match(/#[^/]+\/(?:[^/]+\/)?([a-zA-Z0-9_-]+)$/);
      if (hashMatch) {
        const emailId = hashMatch[1];
        return {
          type: "email",
          emailId,
        };
      }
    }

    return null;
  } catch (error) {
    // Invalid URL format
    return null;
  }
}

/**
 * Parse Google Calendar URL to extract event ID
 *
 * Supports formats:
 * - https://calendar.google.com/calendar/u/0/r/eventedit/ABC123xyz
 * - https://calendar.google.com/calendar/event?eid=ABC123xyz
 */
export function parseCalendarUrl(input: string): ParsedCalendarUrl | null {
  try {
    // If it doesn't look like a URL, return null
    if (!input.includes("calendar.google.com")) {
      return null;
    }

    const url = new URL(input);

    // Extract from path (eventedit format)
    const eventEditMatch = url.pathname.match(/\/eventedit\/([a-zA-Z0-9_-]+)/);
    if (eventEditMatch) {
      return {
        type: "calendar",
        eventId: eventEditMatch[1],
      };
    }

    // Extract from query parameter
    const eid = url.searchParams.get("eid");
    if (eid) {
      return {
        type: "calendar",
        eventId: eid,
      };
    }

    return null;
  } catch (error) {
    // Invalid URL format
    return null;
  }
}

/**
 * Parse any supported URL (Gmail or Calendar)
 */
export function parseUrl(input: string): ParsedUrl | null {
  const emailParsed = parseGmailUrl(input);
  if (emailParsed) return emailParsed;

  const calendarParsed = parseCalendarUrl(input);
  if (calendarParsed) return calendarParsed;

  return null;
}

/**
 * Decode Gmail's new thread ID format to hexadecimal API format
 * Gmail uses a base-40 encoding with vowel-less character set:
 * BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz
 *
 * Based on research by Arsenal Recon:
 * https://arsenalrecon.com/insights/digging-deeper-into-gmail-urls-and-introducing-gmail-url-decoder
 */
export function decodeGmailThreadId(encodedId: string): string | null {
  try {
    // Gmail's vowel-less alphabet (40 characters - base 40 encoding)
    const GMAIL_ALPHABET = "BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz";

    // Decode from base-40
    let result = BigInt(0);
    for (const char of encodedId) {
      const value = GMAIL_ALPHABET.indexOf(char);
      if (value === -1) {
        // Not a Gmail-encoded ID, might be a regular hex ID
        return null;
      }
      result = result * BigInt(40) + BigInt(value);
    }

    // Convert to hex string
    const hexString = result.toString(16);

    // Convert hex to ASCII to get the format like "f:1860158081273140803"
    const ascii = Buffer.from(hexString, "hex").toString("ascii");

    // Extract the numeric ID after "f:" or "thread-f:" or "msg-f:"
    const match = ascii.match(/(?:thread-)?(?:msg-)?f:(\d+)/);
    if (match) {
      const decimalId = match[1];
      // Convert decimal to hexadecimal for Gmail API
      const hexId = BigInt(decimalId).toString(16);
      return hexId;
    }

    return null;
  } catch (error) {
    // If decoding fails, return null
    return null;
  }
}

/**
 * Extract email ID from input - supports both raw IDs and Gmail URLs
 */
export function extractEmailId(input: string): string {
  const parsed = parseGmailUrl(input);
  if (!parsed?.emailId) {
    // If not a URL, try to decode as standalone base-40 encoded ID
    const decodedId = decodeGmailThreadId(input);
    if (decodedId) {
      return decodedId;
    }
    return input;
  }

  // Try to decode Gmail's new thread ID format
  const decodedId = decodeGmailThreadId(parsed.emailId);
  if (decodedId) {
    return decodedId;
  }

  return parsed.emailId;
}

/**
 * Extract event ID from input - supports both raw IDs and Calendar URLs
 */
export function extractEventId(input: string): string {
  const parsed = parseCalendarUrl(input);
  return parsed?.eventId || input;
}
