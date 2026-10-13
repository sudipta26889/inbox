import chunk from "lodash/chunk";
import uniqBy from "lodash/uniqBy";
import { ThreadTrackerType } from "@/generated/prisma/enums";
import { ONE_DAY_MS } from "@/utils/date";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";

// Trackers older than this are counted as stale, not listed. Most are rot
// from before outbound replies were processed (the process-sent.ts flow that
// Task 8 creates); listing them would bury the current queue.
const REPLY_WINDOW_DAYS = 30;
// ponytail: bounds thread fetches per mailbox; raise if a real queue is longer.
const MAX_THREADS_CHECKED = 40;
// Sequential batches keep Gmail/Graph from being hit with 40 parallel reads.
const FETCH_BATCH_SIZE = 5;

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

// staleCount: in-window-excluded trackers older than the window.
// unverifiedCount: trackers we could not check against the live thread (past
// the cap, or the fetch threw). Neither is treated as resolved or deleted.
export type ReplyState = {
  items: ReplyItem[];
  staleCount: number;
  unverifiedCount: number;
};

export async function collectReplyState({
  accountIndex,
  accountEmail,
  emailAccountId,
  provider,
  now,
  logger,
}: {
  accountIndex: number;
  accountEmail: string;
  emailAccountId: string;
  provider: EmailProvider;
  now: Date;
  logger: Logger;
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
  const inWindow = perThread.filter(
    (tracker) => tracker.sentAt.getTime() >= cutoff,
  );
  const checked = inWindow.slice(0, MAX_THREADS_CHECKED);

  let fetchFailures = 0;
  const latestMessages: (ParsedMessage | null)[] = [];
  for (const batch of chunk(checked, FETCH_BATCH_SIZE)) {
    const results = await Promise.all(
      batch.map((tracker) =>
        provider.getLatestMessageInThread(tracker.threadId).catch((error) => {
          fetchFailures++;
          logger.warn("Could not verify reply thread", {
            threadId: tracker.threadId,
            error,
          });
          return null;
        }),
      ),
    );
    latestMessages.push(...results);
  }

  // The tracker table is not trusted on its own: the live thread decides.
  return classifyReplyState({
    accountIndex,
    accountEmail,
    trackers: checked,
    latestMessages,
    isSent: (message) => provider.isSentMessage(message),
    staleCount: perThread.length - inWindow.length,
    unverifiedCount: inWindow.length - checked.length + fetchFailures,
  });
}

export function classifyReplyState({
  accountIndex,
  accountEmail,
  trackers,
  latestMessages,
  isSent,
  staleCount,
  unverifiedCount,
}: {
  accountIndex: number;
  accountEmail: string;
  trackers: TrackerRow[];
  latestMessages: (ParsedMessage | null)[];
  isSent: (message: ParsedMessage) => boolean;
  staleCount: number;
  unverifiedCount: number;
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

  return { items, staleCount, unverifiedCount };
}
