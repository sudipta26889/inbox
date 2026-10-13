import { describe, expect, it, vi } from "vitest";
import { ThreadTrackerType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider } from "@/utils/email/types";
import { createScopedLogger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { classifyReplyState, collectReplyState } from "./reply-state";

vi.mock("@/utils/prisma");

const sentAt = new Date("2026-10-10T10:00:00Z");
const now = new Date("2026-10-13T10:00:00Z");
const logger = createScopedLogger("test");

describe("classifyReplyState", () => {
  it("drops NEEDS_REPLY when I sent the latest message (the Redislabs case)", () => {
    const state = classifyReplyState({
      accountIndex: 1,
      accountEmail: "me@deca.com",
      trackers: [trackerRow("t1", ThreadTrackerType.NEEDS_REPLY, sentAt)],
      latestMessages: [msg({ from: "me@deca.com", sent: true })],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 0,
      unverifiedCount: 0,
    });
    expect(state.items).toEqual([]);
  });

  it("keeps NEEDS_REPLY when they wrote last", () => {
    const state = classifyReplyState({
      accountIndex: 1,
      accountEmail: "me@deca.com",
      trackers: [trackerRow("t1", ThreadTrackerType.NEEDS_REPLY, sentAt)],
      latestMessages: [
        msg({ from: "Liviu <liviu@deca.com>", subject: "Which project?" }),
      ],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 3,
      unverifiedCount: 2,
    });
    expect(state).toEqual({
      staleCount: 3,
      unverifiedCount: 2,
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
        trackerRow("answered", ThreadTrackerType.AWAITING, sentAt),
        trackerRow("quiet", ThreadTrackerType.AWAITING, sentAt),
        trackerRow("deleted", ThreadTrackerType.AWAITING, sentAt),
      ],
      latestMessages: [
        msg({ from: "bank@hdfc.in" }),
        msg({ from: "me@gmail.com", to: "bank@hdfc.in", sent: true }),
        null,
      ],
      isSent: (m) => m.labelIds?.includes("SENT") ?? false,
      staleCount: 0,
      unverifiedCount: 0,
    });
    expect(
      state.items.map((i) => [i.id, i.threadId, i.kind, i.counterpart]),
    ).toEqual([["2.r1", "quiet", "awaiting", "bank@hdfc.in"]]);
  });
});

describe("collectReplyState", () => {
  it("separates stale, unverified, gone and valid trackers", async () => {
    const oldSentAt = new Date("2026-08-01T10:00:00Z");
    prisma.threadTracker.findMany.mockResolvedValue([
      trackerRow("valid", ThreadTrackerType.NEEDS_REPLY, sentAt),
      trackerRow("failing", ThreadTrackerType.AWAITING, sentAt),
      trackerRow("gone", ThreadTrackerType.AWAITING, sentAt),
      trackerRow("old", ThreadTrackerType.NEEDS_REPLY, oldSentAt),
    ]);
    const provider = {
      getLatestMessageInThread: vi.fn(async (threadId: string) => {
        if (threadId === "failing") throw new Error("Gmail 503");
        if (threadId === "gone") return null;
        return msg({
          from: "Liviu <liviu@deca.com>",
          subject: "Which project?",
        });
      }),
      isSentMessage: (m: ParsedMessage) =>
        m.labelIds?.includes("SENT") ?? false,
    } as unknown as EmailProvider;

    const state = await collectReplyState({
      accountIndex: 1,
      accountEmail: "me@deca.com",
      emailAccountId: "acc1",
      provider,
      now,
      logger,
    });

    expect(state).toEqual({
      staleCount: 1,
      unverifiedCount: 1,
      items: [
        {
          id: "1.r1",
          accountEmail: "me@deca.com",
          kind: "needs_reply",
          threadId: "valid",
          counterpart: "Liviu <liviu@deca.com>",
          subject: "Which project?",
          sentAt,
        },
      ],
    });
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

function trackerRow(threadId: string, type: ThreadTrackerType, sentAt: Date) {
  return {
    id: `row-${threadId}`,
    createdAt: sentAt,
    updatedAt: sentAt,
    sentAt,
    threadId,
    messageId: `m-${threadId}`,
    resolved: false,
    type,
    followUpAppliedAt: null,
    followUpDraftId: null,
    emailAccountId: "acc1",
  };
}
