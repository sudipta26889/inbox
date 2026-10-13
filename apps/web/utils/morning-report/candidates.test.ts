import { describe, expect, it, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import {
  collectCandidates,
  foldCandidates,
  normalizeSubject,
} from "./candidates";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

describe("normalizeSubject", () => {
  it("folds reply prefixes, hashes and numbers", () => {
    expect(normalizeSubject("Re: Fwd: Run failed: CI - main (59ada4a)")).toBe(
      normalizeSubject("Run failed: CI - main (203f115)"),
    );
    expect(normalizeSubject("REF. 091026I049904394 EUR 2090.00")).toBe(
      normalizeSubject("REF. 121026I049903591 EUR 2090.00"),
    );
  });

  it("keeps short numbers distinct, so card endings and amounts do not fold", () => {
    expect(normalizeSubject("Statement for card XX1234 - due 14 Oct")).not.toBe(
      normalizeSubject("Statement for card XX5678 - due 20 Oct"),
    );
    expect(normalizeSubject("Debit of INR 500")).not.toBe(
      normalizeSubject("Debit of INR 50,000"),
    );
  });
});

describe("foldCandidates", () => {
  it("drops bulk mail into counts and keeps everything else", () => {
    const { candidates, bulkCounts } = foldCandidates({
      accountIndex: 1,
      accountEmail: "me@gmail.com",
      messages: [
        message({
          id: "m1",
          from: "Steam <noreply@steampowered.com>",
          subject: "Sale!",
          at: 3,
        }),
        message({
          id: "m2",
          from: "credit_cards@icici.bank.in",
          subject: "EMI on Card",
          at: 2,
        }),
      ],
      rulesByMessage: new Map([
        ["m1", [{ name: "Marketing", systemType: SystemType.MARKETING }]],
        ["m2", [{ name: "Bills", systemType: null }]],
      ]),
    });

    expect(bulkCounts).toEqual({ Marketing: 1 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "1.1",
      messageId: "m2",
      rules: ["Bills"],
      count: 1,
    });
  });

  it("keeps a message that is bulk-tagged but also carries a real rule", () => {
    const { candidates, bulkCounts } = foldCandidates({
      accountIndex: 1,
      accountEmail: "me@gmail.com",
      messages: [
        message({
          id: "m1",
          from: "shop@example.com",
          subject: "Receipt",
          at: 1,
        }),
      ],
      rulesByMessage: new Map([
        [
          "m1",
          [
            { name: "Marketing", systemType: SystemType.MARKETING },
            { name: "Bills", systemType: null },
          ],
        ],
      ]),
    });

    expect(bulkCounts).toEqual({});
    expect(candidates[0]).toMatchObject({
      messageId: "m1",
      rules: ["Marketing", "Bills"],
    });
  });

  it("lists a repeated rule once per message", () => {
    const { candidates } = foldCandidates({
      accountIndex: 1,
      accountEmail: "me@gmail.com",
      messages: [message({ id: "m1", from: "a@b.com", subject: "Hi", at: 1 })],
      rulesByMessage: new Map([
        [
          "m1",
          [
            { name: "Bills", systemType: null },
            { name: "Bills", systemType: null },
          ],
        ],
      ]),
    });
    expect(candidates[0].rules).toEqual(["Bills"]);
  });

  it("keeps a NOTIFICATION-ruled email, since that rule swallows real alerts", () => {
    const { candidates } = foldCandidates({
      accountIndex: 1,
      accountEmail: "me@gmail.com",
      messages: [
        message({
          id: "m1",
          from: "noreply@github.com",
          subject: "PAT requests",
          at: 1,
        }),
      ],
      rulesByMessage: new Map([
        ["m1", [{ name: "Notification", systemType: SystemType.NOTIFICATION }]],
      ]),
    });
    expect(candidates).toHaveLength(1);
  });

  it("folds near-duplicates from one sender into the newest, with a count", () => {
    const { candidates } = foldCandidates({
      accountIndex: 2,
      accountEmail: "me@x.com",
      messages: [
        message({
          id: "old",
          from: "ProDevs <info@prodevs.in>",
          subject: "Please moderate: Post 8f3a2c1",
          at: 1,
        }),
        message({
          id: "new",
          from: "ProDevs <info@prodevs.in>",
          subject: "Please moderate: Post 9b4d7e2",
          at: 5,
        }),
        message({
          id: "other",
          from: "Liviu <liviu@deca.com>",
          subject: "Question",
          at: 3,
        }),
      ],
      rulesByMessage: new Map(),
    });

    expect(candidates.map((c) => [c.id, c.messageId, c.count])).toEqual([
      ["2.1", "new", 2],
      ["2.2", "other", 1],
    ]);
  });

  it("strips invisible padding characters from snippets", () => {
    const { candidates } = foldCandidates({
      accountIndex: 1,
      accountEmail: "me@gmail.com",
      messages: [
        message({
          id: "m1",
          from: "a@b.com",
          subject: "S",
          at: 1,
          snippet: "Shipped͏ ‌͏ ‌ done",
        }),
      ],
      rulesByMessage: new Map(),
    });
    expect(candidates[0].snippet).toBe("Shipped done");
  });
});

describe("collectCandidates", () => {
  it("pages through the provider, drops sent mail and joins rule tags", async () => {
    const since = new Date("2026-10-10T00:00:00Z");
    const pages = [
      {
        messages: [
          message({ id: "m1", from: "a@b.com", subject: "One", at: 2 }),
        ],
        nextPageToken: "next",
      },
      {
        messages: [
          message({ id: "sent", from: "me@gmail.com", subject: "Mine", at: 3 }),
          message({ id: "m2", from: "c@d.com", subject: "Two", at: 1 }),
        ],
      },
    ];
    const getMessagesWithPagination = vi
      .fn()
      .mockResolvedValueOnce(pages[0])
      .mockResolvedValueOnce(pages[1]);
    const provider = {
      getMessagesWithPagination,
      isSentMessage: (m: ParsedMessage) => m.id === "sent",
    } as unknown as EmailProvider;

    prisma.executedRule.findMany.mockResolvedValue([
      { messageId: "m1", rule: { name: "Bills", systemType: null } },
      { messageId: "m1", rule: { name: "Bills", systemType: null } },
      { messageId: "m2", rule: null },
    ] as never);

    const result = await collectCandidates({
      accountIndex: 3,
      accountEmail: "me@gmail.com",
      emailAccountId: "ea_1",
      provider,
      since,
    });

    expect(getMessagesWithPagination).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ after: since, inboxOnly: false }),
    );
    expect(getMessagesWithPagination).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "next" }),
    );
    expect(result.truncated).toBe(false);
    expect(result.candidates.map((c) => [c.id, c.messageId, c.rules])).toEqual([
      ["3.1", "m1", ["Bills"]],
      ["3.2", "m2", []],
    ]);
  });
});

function message({
  id,
  from,
  subject,
  at,
  snippet = "",
}: {
  id: string;
  from: string;
  subject: string;
  at: number;
  snippet?: string;
}): ParsedMessage {
  return {
    id,
    threadId: `t-${id}`,
    historyId: "1",
    internalDate: String(Date.UTC(2026, 9, 12, at)),
    date: "",
    subject,
    snippet,
    inline: [],
    headers: { from, to: "me@gmail.com", subject, date: "" },
  } as ParsedMessage;
}
