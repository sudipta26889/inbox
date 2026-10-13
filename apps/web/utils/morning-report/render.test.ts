import { describe, expect, it } from "vitest";
import type { Candidate } from "./candidates";
import {
  accountTag,
  MAX_REPORT_CHARS,
  type RenderInput,
  renderMorningReport,
} from "./render";

const now = new Date("2026-10-13T03:30:00Z"); // Tue 09:00 IST

describe("accountTag", () => {
  it("uses the provider for personal mailboxes and the domain otherwise", () => {
    expect(accountTag("sudiptai26.889@gmail.com")).toBe("gmail");
    expect(accountTag("sudipta.dhara@decagames.com")).toBe("decagames");
    expect(accountTag("admin@sudiptadhara.in")).toBe("sudiptadhara");
  });
});

describe("renderMorningReport", () => {
  it("renders sections in fixed order with account tags", () => {
    const text = renderMorningReport(
      input({
        candidates: [
          cand(
            "1.1",
            "me@gmail.com",
            "credit_cards@icici.bank.in",
            "EMI on Card",
          ),
          cand(
            "2.1",
            "me@decagames.com",
            "no_reply@email.apple.com",
            "Build 301 issues",
          ),
        ],
        replyItems: [
          {
            id: "2.r1",
            accountEmail: "me@decagames.com",
            kind: "needs_reply",
            threadId: "t",
            counterpart: "Liviu <l@deca.com>",
            subject: "Q",
            sentAt: new Date("2026-10-08T03:30:00Z"),
          },
        ],
        selection: {
          items: [
            {
              id: "2.1",
              section: "action",
              note: "DragonVale build 301 flagged — fix and resubmit",
            },
            {
              id: "1.1",
              section: "money",
              note: "₹2,62,900 converted to EMI, card 7005",
            },
            {
              id: "2.r1",
              section: "reply",
              note: "Liviu asks which project an invoice is for",
            },
          ],
        },
        events: [
          {
            accountEmail: "me@decagames.com",
            event: {
              id: "e",
              title: "Producer AI Copilot Pt.2",
              startTime: new Date("2026-10-13T10:00:00Z"),
              endTime: new Date("2026-10-13T11:00:00Z"),
              attendees: [],
            },
          },
        ],
        bulkCounts: { Marketing: 77, Newsletter: 45 },
        staleReplyCount: 6,
      }),
    );

    expect(text).toBe(
      [
        "☀️ Morning report — Tue 13 Oct",
        "",
        "💰 Money",
        "• ₹2,62,900 converted to EMI, card 7005 [gmail]",
        "",
        "📅 Today",
        "• 15:30–16:30 Producer AI Copilot Pt.2 [decagames]",
        "",
        "✅ To do",
        "• DragonVale build 301 flagged — fix and resubmit [decagames]",
        "",
        "✉️ Reply needed",
        "• Liviu asks which project an invoice is for · 5d [decagames]",
        "",
        "Skipped: 77 Marketing, 45 Newsletter · 6 reply threads older than 30 days",
      ].join("\n"),
    );
  });

  it("merges the same email seen in two mailboxes into one line", () => {
    const text = renderMorningReport(
      input({
        candidates: [
          cand(
            "1.1",
            "me@gmail.com",
            "workspace-noreply@google.com",
            "[Action Required] Mark AI agent OAuth clients",
          ),
          cand(
            "2.1",
            "admin@sudiptadhara.in",
            "workspace-noreply@google.com",
            "[Action Required] Mark AI agent OAuth clients",
          ),
        ],
        selection: {
          items: [
            {
              id: "1.1",
              section: "deadline",
              note: "Mark AI agent OAuth clients as agentic by 11 Nov",
            },
            { id: "2.1", section: "deadline", note: "dupe" },
          ],
        },
      }),
    );
    expect(text).toContain(
      "• Mark AI agent OAuth clients as agentic by 11 Nov [gmail, sudiptadhara]",
    );
    expect(text).not.toContain("dupe");
  });

  it("leads with connection problems, read failures and a missed-run notice", () => {
    const text = renderMorningReport(
      input({
        since: new Date("2026-10-09T03:30:00Z"),
        previousRunMissed: true,
        problems: [
          {
            emailAccountId: "ea-deca",
            email: "me@decagames.com",
            problem: "mailbox",
          },
        ],
        failures: [{ email: "admin@sudiptadhara.in", error: "Rate limited" }],
        truncatedAccounts: ["me@gmail.com"],
      }),
    );
    expect(text).toBe(
      [
        "☀️ Morning report — Tue 13 Oct",
        "Covers mail since Fri 9 Oct, 09:00 — an earlier report was missed.",
        "",
        "⚠️ Problems",
        "• me@decagames.com: mailbox disconnected, not checked. Reconnect: https://inbox.example.com/ea-deca/permissions/consent",
        "• admin@sudiptadhara.in: could not be read (Rate limited)",
        "• me@gmail.com: more mail than one report covers; oldest left out",
        "",
        "Nothing else needs you today.",
      ].join("\n"),
    );
  });

  it("says so in one line when nothing needs attention", () => {
    expect(renderMorningReport(input({}))).toBe(
      "☀️ Morning report — Tue 13 Oct\n\nNothing needs you today.",
    );
  });

  it("caps length on whole lines and keeps the Skipped footer", () => {
    const text = renderMorningReport(
      input({ ...manyItems(), bulkCounts: { Marketing: 3 } }),
    );
    expect(text.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(text).toMatch(
      /…and \d+ more lines — open Inbox for the rest\.\n\nSkipped: 3 Marketing$/,
    );
  });

  it("ends with the marker when there is no footer", () => {
    const text = renderMorningReport(input(manyItems()));
    expect(text.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
    expect(text).toMatch(/…and \d+ more lines — open Inbox for the rest\.$/);
    expect(text).not.toMatch(/\n\n…and/);
  });

  it("truncates long read-failure errors", () => {
    const text = renderMorningReport(
      input({ failures: [{ email: "a@b.com", error: "e".repeat(400) }] }),
    );
    expect(text).toContain(`(${"e".repeat(150)}…)`);
    expect(text).not.toContain("e".repeat(151));
  });

  it("never renders a negative reply age", () => {
    const text = renderMorningReport(
      input({
        replyItems: [
          {
            id: "1.r1",
            accountEmail: "me@gmail.com",
            kind: "needs_reply",
            threadId: "t",
            counterpart: "L",
            subject: "Q",
            sentAt: new Date("2026-10-14T03:30:00Z"),
          },
        ],
        selection: {
          items: [{ id: "1.r1", section: "reply", note: "Reply to L" }],
        },
      }),
    );
    expect(text).toContain("• Reply to L · 0d [gmail]");
  });
});

function manyItems(): Partial<RenderInput> {
  const many = Array.from({ length: 200 }, (_, i) =>
    cand(`1.${i + 1}`, "me@gmail.com", `s${i}@x.com`, `Subject ${i}`),
  );
  return {
    candidates: many,
    selection: {
      items: many.map((c) => ({
        id: c.id,
        section: "action" as const,
        note: `Item ${c.id} ${"y".repeat(60)}`,
      })),
    },
  };
}

function input(overrides: Partial<RenderInput>): RenderInput {
  return {
    now,
    timeZone: "Asia/Calcutta",
    since: new Date("2026-10-12T03:30:00Z"),
    previousRunMissed: false,
    selection: { items: [] },
    candidates: [],
    replyItems: [],
    events: [],
    bulkCounts: {},
    staleReplyCount: 0,
    unverifiedReplyCount: 0,
    problems: [],
    failures: [],
    truncatedAccounts: [],
    baseUrl: "https://inbox.example.com",
    ...overrides,
  };
}

function cand(
  id: string,
  accountEmail: string,
  from: string,
  subject: string,
): Candidate {
  return {
    id,
    accountEmail,
    messageId: id,
    threadId: id,
    from,
    subject,
    snippet: "",
    date: now,
    rules: [],
    count: 1,
  };
}
