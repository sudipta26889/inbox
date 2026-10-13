// utils/ai/morning-report/select-items.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "@/utils/morning-report/candidates";
import type { ReplyItem } from "@/utils/morning-report/reply-state";

vi.mock("server-only", () => ({}));

import {
  sanitizeSelection,
  selectionSchema,
  stripLinksAndMarkup,
} from "./select-items";

const candidate = { id: "1.1", subject: "EMI on Card" } as Candidate;
const reply = { id: "1.r1", kind: "awaiting" } as ReplyItem;

describe("sanitizeSelection", () => {
  it("drops IDs the model invented and duplicates", () => {
    const result = sanitizeSelection(
      {
        items: [
          { id: "1.1", section: "money", note: "₹2,62,900 EMI" },
          { id: "9.9", section: "money", note: "made up" },
          { id: "1.1", section: "deadline", note: "dupe" },
        ],
      },
      { candidates: [candidate], replyItems: [reply] },
    );
    expect(result.items).toEqual([
      { id: "1.1", section: "money", note: "₹2,62,900 EMI" },
    ]);
    expect(result.droppedCount).toBe(1);
  });

  it("forces reply items into their verified section and keeps candidates out of reply sections", () => {
    const result = sanitizeSelection(
      {
        items: [
          { id: "1.r1", section: "reply", note: "HDFC remittance" },
          { id: "1.1", section: "waiting", note: "EMI" },
        ],
      },
      { candidates: [candidate], replyItems: [reply] },
    );
    expect(result.items).toEqual([
      { id: "1.r1", section: "waiting", note: "HDFC remittance" },
      { id: "1.1", section: "action", note: "EMI" },
    ]);
  });

  it("collapses whitespace and caps note length", () => {
    const result = sanitizeSelection(
      {
        items: [
          { id: "1.1", section: "money", note: `  a\n\n b ${"x".repeat(300)}` },
        ],
      },
      { candidates: [candidate], replyItems: [] },
    );
    expect(result.items[0].note.startsWith("a b x")).toBe(true);
    expect(result.items[0].note.length).toBe(160);
  });

  it("strips URLs and markup from notes", () => {
    const result = sanitizeSelection(
      {
        items: [
          {
            id: "1.1",
            section: "money",
            note: "Pay now at https://evil.example/x and www.bad.com or evil.io/a?b=1 <b>hi</b>",
          },
        ],
      },
      { candidates: [candidate], replyItems: [] },
    );
    const note = result.items[0].note;
    expect(note).not.toMatch(/https?:|www\.|evil|bad\.com|[<>]/);
    expect(note).toContain("Pay now at");
    expect(note).toContain("hi");
  });
});

describe("stripLinksAndMarkup", () => {
  it.each([
    "₹2,62,900 EMI",
    "A/c XX1234 debited",
    "due Oct 31",
    "2.5G/USB hub",
    "card 7005",
    "EMI 3/12",
    "e.g. a refund, Rs.500 charged",
  ])("keeps %s intact", (text) => {
    expect(stripLinksAndMarkup(text)).toBe(text);
  });

  it.each([
    ["lookalike-bank.co", /lookalike-bank\.co/],
    ["pay at bank.com today", /bank\.com/],
    ["see Login.HDFC-Secure.Verify.IN now", /\.IN|Verify\.IN/],
  ])("neutralises bare domain in %s", (text, linkLike) => {
    const out = stripLinksAndMarkup(text);
    expect(out).not.toMatch(linkLike);
    expect(out).toContain("[.]");
  });
});

describe("selectionSchema", () => {
  it("accepts the near-misses a gateway model produces without the JSON schema", () => {
    const parsed = selectionSchema.parse([
      { id: 1.3, section: "Money", note: "ICICI EMI" },
      { id: "2.1", section: "Deadlines" },
      { id: "1.r1", section: "Needs Reply", note: null },
      { id: "1.4", section: "something odd", note: "x" },
    ]);
    expect(parsed.items).toEqual([
      { id: "1.3", section: "money", note: "ICICI EMI" },
      { id: "2.1", section: "deadline", note: "" },
      { id: "1.r1", section: "reply", note: "" },
      { id: "1.4", section: "action", note: "x" },
    ]);
  });
});
