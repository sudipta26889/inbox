import uniqBy from "lodash/uniqBy";
import { ThreadTrackerType } from "@/generated/prisma/enums";
import { ONE_DAY_MS } from "@/utils/date";
import type { EmailProvider } from "@/utils/email/types";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";

// Older open trackers are mostly rot from before outbound replies were
// processed (see process-sent.ts); they are counted, not listed.
const REPLY_WINDOW_DAYS = 30;
// ponytail: bounds thread fetches per mailbox; raise if a real queue is longer.
const MAX_THREADS_CHECKED = 40;

type TrackerRow = { threadId: string; type: ThreadTrackerType; sentAt: Date };

export type ReplyItem = {
  id: string;
  accountEmail: string;
  kind: "needs_reply" | "awaiting";
  threadId: string;
  counterpart: string;
  subject: string;
  sentAt: Date;
};

export type ReplyState = { items: ReplyItem[]; staleCount: number };

export async function collectReplyState({
  accountIndex,
  accountEmail,
  emailAccountId,
  provider,
  now,
}: {
  accountIndex: number;
  accountEmail: string;
  emailAccountId: string;
  provider: EmailProvider;
  now: Date;
}): Promise<ReplyState> {
  const trackers = await prisma.threadTracker.findMany({
    where: {
      emailAccountId,
      resolved: false,
      type: { in: [ThreadTrackerType.NEEDS_REPLY, ThreadTrackerType.AWAITING] },
    },
    select: { threadId: true, type: true, sentAt: true },
    orderBy: { sentAt: "desc" },
  });

  const perThread = uniqBy(trackers, (tracker) => tracker.threadId);
  const cutoff = now.getTime() - REPLY_WINDOW_DAYS * ONE_DAY_MS;
  const checked = perThread
    .filter((tracker) => tracker.sentAt.getTime() >= cutoff)
    .slice(0, MAX_THREADS_CHECKED);

  // The tracker table is not trusted on its own: the live thread decides.
  const latestMessages = await Promise.all(
    checked.map((tracker) =>
      provider.getLatestMessageInThread(tracker.threadId).catch(() => null),
    ),
  );

  return classifyReplyState({
    accountIndex,
    accountEmail,
    trackers: checked,
    latestMessages,
    isSent: (message) => provider.isSentMessage(message),
    staleCount: perThread.length - checked.length,
  });
}

export function classifyReplyState({
  accountIndex,
  accountEmail,
  trackers,
  latestMessages,
  isSent,
  staleCount,
}: {
  accountIndex: number;
  accountEmail: string;
  trackers: TrackerRow[];
  latestMessages: (ParsedMessage | null)[];
  isSent: (message: ParsedMessage) => boolean;
  staleCount: number;
}): ReplyState {
  const items: ReplyItem[] = [];

  trackers.forEach((tracker, index) => {
    const latest = latestMessages[index];
    if (!latest) return;

    const needsReply = tracker.type === ThreadTrackerType.NEEDS_REPLY;
    const iWroteLast = isSent(latest);
    if (needsReply === iWroteLast) return;

    items.push({
      id: `${accountIndex}.r${items.length + 1}`,
      accountEmail,
      kind: needsReply ? "needs_reply" : "awaiting",
      threadId: tracker.threadId,
      counterpart: needsReply ? latest.headers.from : latest.headers.to,
      subject: latest.headers.subject || "(no subject)",
      sentAt: tracker.sentAt,
    });
  });

  return { items, staleCount };
}
