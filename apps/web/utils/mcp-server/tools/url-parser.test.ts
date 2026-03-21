import { describe, it, expect } from "vitest";
import {
  parseGmailUrl,
  parseCalendarUrl,
  parseUrl,
  extractEmailId,
  extractEventId,
  decodeGmailThreadId,
} from "./url-parser";

describe("parseGmailUrl", () => {
  it("should parse Gmail URL with permthid and simpl parameters", () => {
    const url =
      "https://mail.google.com/mail/u/0/?ik=54c0f4487e&view=pt&search=all&permthid=thread-f:1857728267523417974&simpl=msg-f:1857728267523417974";
    const result = parseGmailUrl(url);

    expect(result).toEqual({
      type: "email",
      emailId: "1857728267523417974",
      threadId: "1857728267523417974",
    });
  });

  it("should parse Gmail URL with multiple simpl parameters", () => {
    const url =
      "https://mail.google.com/mail/u/0/?ik=54c0f4487e&view=pt&search=all&permthid=thread-f:1857728267523417974&simpl=msg-f:1857728267523417974&simpl=msg-a:r3820766222875663954";
    const result = parseGmailUrl(url);

    expect(result).toEqual({
      type: "email",
      emailId: "1857728267523417974",
      threadId: "1857728267523417974",
    });
  });

  it("should parse Gmail hash URL with inbox", () => {
    const url = "https://mail.google.com/mail/u/0/#inbox/1857728267523417974";
    const result = parseGmailUrl(url);

    expect(result).toEqual({
      type: "email",
      emailId: "1857728267523417974",
    });
  });

  it("should parse Gmail hash URL with label", () => {
    const url =
      "https://mail.google.com/mail/u/0/#label/Important/1857728267523417974";
    const result = parseGmailUrl(url);

    expect(result).toEqual({
      type: "email",
      emailId: "1857728267523417974",
    });
  });

  it("should return null for non-Gmail URLs", () => {
    const url = "https://example.com/something";
    const result = parseGmailUrl(url);

    expect(result).toBeNull();
  });

  it("should return null for plain email IDs", () => {
    const emailId = "1857728267523417974";
    const result = parseGmailUrl(emailId);

    expect(result).toBeNull();
  });

  it("should return null for invalid URLs", () => {
    const url = "not-a-url";
    const result = parseGmailUrl(url);

    expect(result).toBeNull();
  });

  it("should return null for Gmail search URLs (not API-compatible)", () => {
    const url =
      "https://mail.google.com/mail/u/0/#search/star+health/FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = parseGmailUrl(url);

    expect(result).toBeNull();
  });

  it("should parse Gmail base-40 encoded hash IDs (new UI format)", () => {
    const url =
      "https://mail.google.com/mail/u/0/#inbox/FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = parseGmailUrl(url);

    // Gmail's new UI uses base-40 encoding which we can decode
    expect(result).toEqual({
      type: "email",
      emailId: "FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF",
    });
  });
});

describe("parseCalendarUrl", () => {
  it("should parse Google Calendar URL with eid parameter", () => {
    const url = "https://calendar.google.com/calendar/event?eid=ABC123xyz";
    const result = parseCalendarUrl(url);

    expect(result).toEqual({
      type: "calendar",
      eventId: "ABC123xyz",
    });
  });

  it("should parse Google Calendar URL with eventedit path", () => {
    const url =
      "https://calendar.google.com/calendar/u/0/r/eventedit/ABC123xyz";
    const result = parseCalendarUrl(url);

    expect(result).toEqual({
      type: "calendar",
      eventId: "ABC123xyz",
    });
  });

  it("should return null for non-Calendar URLs", () => {
    const url = "https://example.com/calendar";
    const result = parseCalendarUrl(url);

    expect(result).toBeNull();
  });

  it("should return null for plain event IDs", () => {
    const eventId = "ABC123xyz";
    const result = parseCalendarUrl(eventId);

    expect(result).toBeNull();
  });
});

describe("parseUrl", () => {
  it("should parse Gmail URLs", () => {
    const url =
      "https://mail.google.com/mail/u/0/?ik=54c0f4487e&view=pt&search=all&permthid=thread-f:1857728267523417974&simpl=msg-f:1857728267523417974";
    const result = parseUrl(url);

    expect(result?.type).toBe("email");
    expect((result as any)?.emailId).toBe("1857728267523417974");
  });

  it("should parse Calendar URLs", () => {
    const url = "https://calendar.google.com/calendar/event?eid=ABC123xyz";
    const result = parseUrl(url);

    expect(result?.type).toBe("calendar");
    expect((result as any)?.eventId).toBe("ABC123xyz");
  });

  it("should return null for unsupported URLs", () => {
    const url = "https://example.com/something";
    const result = parseUrl(url);

    expect(result).toBeNull();
  });
});

describe("extractEmailId", () => {
  it("should extract email ID from Gmail URL", () => {
    const url =
      "https://mail.google.com/mail/u/0/?ik=54c0f4487e&view=pt&search=all&permthid=thread-f:1857728267523417974&simpl=msg-f:1857728267523417974";
    const result = extractEmailId(url);

    expect(result).toBe("1857728267523417974");
  });

  it("should return raw ID if not a URL", () => {
    const emailId = "1857728267523417974";
    const result = extractEmailId(emailId);

    expect(result).toBe("1857728267523417974");
  });

  it("should handle hash-style Gmail URLs", () => {
    const url = "https://mail.google.com/mail/u/0/#inbox/1857728267523417974";
    const result = extractEmailId(url);

    expect(result).toBe("1857728267523417974");
  });
});

describe("extractEventId", () => {
  it("should extract event ID from Calendar URL", () => {
    const url = "https://calendar.google.com/calendar/event?eid=ABC123xyz";
    const result = extractEventId(url);

    expect(result).toBe("ABC123xyz");
  });

  it("should return raw ID if not a URL", () => {
    const eventId = "ABC123xyz";
    const result = extractEventId(eventId);

    expect(result).toBe("ABC123xyz");
  });

  it("should handle eventedit-style URLs", () => {
    const url =
      "https://calendar.google.com/calendar/u/0/r/eventedit/ABC123xyz";
    const result = extractEventId(url);

    expect(result).toBe("ABC123xyz");
  });
});

describe("decodeGmailThreadId", () => {
  it("should decode Gmail base-40 encoded thread ID", () => {
    // Real example from user's Gmail
    const encodedId = "FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = decodeGmailThreadId(encodedId);

    // This should decode to 19d09beb5c5b9643 (the "Reimbursement Query" email)
    expect(result).toBe("19d09beb5c5b9643");
  });

  it("should return null for non-Gmail encoded IDs", () => {
    const hexId = "1857728267523417974";
    const result = decodeGmailThreadId(hexId);

    expect(result).toBeNull();
  });

  it("should return null for invalid characters", () => {
    const invalidId = "ABC123@#$";
    const result = decodeGmailThreadId(invalidId);

    expect(result).toBeNull();
  });

  it("should handle different encoded formats", () => {
    // Another test case - if we had more examples
    const encodedId = "FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = decodeGmailThreadId(encodedId);

    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
  });
});

describe("extractEmailId with Gmail encoded IDs", () => {
  it("should decode Gmail URL with base-40 encoded ID", () => {
    const url =
      "https://mail.google.com/mail/u/0/#inbox/FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = extractEmailId(url);

    // Should decode to hex ID
    expect(result).toBe("19d09beb5c5b9643");
  });

  it("should decode Gmail label URL with base-40 encoded ID", () => {
    const url =
      "https://mail.google.com/mail/u/0/#label/Important/FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = extractEmailId(url);

    expect(result).toBe("19d09beb5c5b9643");
  });

  it("should decode standalone base-40 encoded ID", () => {
    const encodedId = "FMfcgzQgKvDcJjpsrBlrXmkgcKvMDkdF";
    const result = extractEmailId(encodedId);

    // Should decode standalone ID (as ChatGPT passes it)
    expect(result).toBe("19d09beb5c5b9643");
  });
});
