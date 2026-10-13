import { describe, expect, it } from "vitest";
import { ThreadTrackerType } from "@/generated/prisma/enums";
import type { ParsedMessage } from "@/utils/types";
import { classifyReplyState } from "./reply-state";

const sentAt = new Date("2026-10-10T10:00:00Z");

describe("classifyReplyState", () => {
  it("drops NEEDS_REPLY when I sent the latest message (the Redislabs case)", () => {
    const state = classifyReplyState({
      accountIndex: 1,
      accountEmail: "me@deca.com",
      trackers: [
        { threadId: "t1", type: ThreadTrackerType.NEEDS_REPLY, sentAt },
      ],
      latestMessages: [msg({ from: "me@deca.com", sent: true })],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 0,
    });
    expect(state.items).toEqual([]);
  });

  it("keeps NEEDS_REPLY when they wrote last", () => {
    const state = classifyReplyState({
      accountIndex: 1,
      accountEmail: "me@deca.com",
      trackers: [
        { threadId: "t1", type: ThreadTrackerType.NEEDS_REPLY, sentAt },
      ],
      latestMessages: [
        msg({ from: "Liviu <liviu@deca.com>", subject: "Which project?" }),
      ],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 3,
    });
    expect(state).toEqual({
      staleCount: 3,
      items: [
        {
          id: "1.r1",
          accountEmail: "me@deca.com",
          kind: "needs_reply",
          threadId: "t1",
          counterpart: "Liviu <liviu@deca.com>",
          subject: "Which project?",
          sentAt,
        },
      ],
    });
  });

  it("drops AWAITING when they already answered, keeps it when I wrote last", () => {
    const state = classifyReplyState({
      accountIndex: 2,
      accountEmail: "me@gmail.com",
      trackers: [
        { threadId: "answered", type: ThreadTrackerType.AWAITING, sentAt },
        { threadId: "quiet", type: ThreadTrackerType.AWAITING, sentAt },
        { threadId: "deleted", type: ThreadTrackerType.AWAITING, sentAt },
      ],
      latestMessages: [
        msg({ from: "bank@hdfc.in" }),
        msg({ from: "me@gmail.com", to: "bank@hdfc.in", sent: true }),
        null,
      ],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 0,
    });
    expect(
      state.items.map((i) => [i.id, i.threadId, i.kind, i.counterpart]),
    ).toEqual([["2.r1", "quiet", "awaiting", "bank@hdfc.in"]]);
  });
});

function msg({
  from,
  to = "me@x.com",
  subject = "S",
  sent = false,
}: {
  from: string;
  to?: string;
  subject?: string;
  sent?: boolean;
}) {
  return {
    id: "m",
    threadId: "t",
    labelIds: sent ? ["SENT"] : ["INBOX"],
    headers: { from, to, subject, date: "" },
  } as ParsedMessage;
}
