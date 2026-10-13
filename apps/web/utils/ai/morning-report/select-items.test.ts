// utils/ai/morning-report/select-items.test.ts
import { describe, expect, it, vi } from "vitest";
import type { Candidate } from "@/utils/morning-report/candidates";
import type { ReplyItem } from "@/utils/morning-report/reply-state";

vi.mock("server-only", () => ({}));

import { sanitizeSelection } from "./select-items";

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
