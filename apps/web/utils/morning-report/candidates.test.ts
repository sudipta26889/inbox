import { describe, expect, it } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import type { ParsedMessage } from "@/utils/types";
import { foldCandidates, normalizeSubject } from "./candidates";

describe("normalizeSubject", () => {
  it("folds reply prefixes, hashes and numbers", () => {
    expect(normalizeSubject("Re: Fwd: Run failed: CI - main (59ada4a)")).toBe(
      normalizeSubject("Run failed: CI - main (203f115)"),
    );
    expect(normalizeSubject("REF. 091026I049904394 EUR 2090.00")).toBe(
      normalizeSubject("REF. 121026I049903591 EUR 2090.00"),
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
          subject: "Please moderate: Post 1",
          at: 1,
        }),
        message({
          id: "new",
          from: "ProDevs <info@prodevs.in>",
          subject: "Please moderate: Post 2",
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
