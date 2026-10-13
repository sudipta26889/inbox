import { env } from "@/env";
import {
  type AgentMemory,
  loadAgentContext,
} from "@/utils/ai/assistant/agent-context";
import {
  aiSelectReportItems,
  sanitizeSelection,
} from "@/utils/ai/morning-report/select-items";
import { ONE_DAY_MS, ONE_HOUR_MS } from "@/utils/date";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { collectCandidates } from "./candidates";
import { fetchTodayEvents } from "./calendar";
import { findConnectionProblems } from "./health";
import { collectReplyState } from "./reply-state";
import { renderMorningReport } from "./render";

const MAX_WINDOW_MS = 7 * ONE_DAY_MS;
// A normal day's window is ~24h; anything clearly longer means a day was lost.
const MISSED_RUN_THRESHOLD_MS = ONE_DAY_MS + 2 * ONE_HOUR_MS;
const MAILBOX_TIMEOUT_MS = 150_000;
const MEMORY_QUERY =
  "morning report: what matters to me, which senders or threads need no reply";

export type MorningReport = {
  text: string;
  since: Date;
  accounts: { emailAccountId: string; email: string }[];
  failures: { emailAccountId: string; email: string; error: string }[];
  readEmailAccountIds: string[];
};

export async function buildMorningReport({
  userId,
  now,
  logger,
}: {
  userId: string;
  now: Date;
  logger: Logger;
}): Promise<MorningReport> {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: {
      id: true,
      email: true,
      timezone: true,
      account: { select: { provider: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  const timeZone = emailAccounts[0]?.timezone || "UTC";
  const problems = await findConnectionProblems({ userId });

  // Reading a mailbox already known to be disconnected only produces a second,
  // vaguer line about the same problem.
  const brokenMailboxes = new Set(
    problems
      .filter((p) => p.problem === "mailbox")
      .map((p) => p.emailAccountId),
  );
  const candidatesToRead = emailAccounts.filter(
    (a) => !brokenMailboxes.has(a.id),
  );
  const readable = candidatesToRead.filter((a) => a.account?.provider);

  const results = await Promise.allSettled(
    readable.map(async (emailAccount, index) =>
      withTimeout(
        readMailbox({
          emailAccountId: emailAccount.id,
          accountEmail: emailAccount.email,
          providerName: emailAccount.account?.provider ?? "",
          accountIndex: index + 1,
          since: await getReportWindowStart({
            emailAccountId: emailAccount.id,
            now,
          }),
          now,
          timeZone,
          logger: logger.with({ emailAccountId: emailAccount.id }),
        }),
        MAILBOX_TIMEOUT_MS,
      ),
    ),
  );

  const reads: MailboxRead[] = [];
  const failures: MorningReport["failures"] = candidatesToRead
    .filter((a) => !a.account?.provider)
    .map((a) => ({
      emailAccountId: a.id,
      email: a.email,
      error: "no mail provider connected",
    }));
  results.forEach((result, index) => {
    const emailAccount = readable[index];
    if (result.status === "fulfilled") {
      reads.push(result.value);
      return;
    }
    logger.error("Morning report could not read mailbox", {
      emailAccountId: emailAccount.id,
      error: result.reason,
    });
    failures.push({
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
      error:
        result.reason instanceof Error
          ? result.reason.message
          : String(result.reason),
    });
  });

  if (!reads.length) {
    throw new Error(
      `No mailbox could be read (${emailAccounts.map((a) => a.email).join(", ")})`,
    );
  }

  const since = new Date(
    Math.min(...reads.map((read) => read.since.getTime())),
  );

  const emailAccount = await getEmailAccountWithAi({
    emailAccountId: reads[0].emailAccountId,
  });
  if (!emailAccount)
    throw new Error("Email account for the report model not found");

  const candidates = reads.flatMap((read) => read.candidates.candidates);
  const replyItems = reads.flatMap((read) => read.replies.items);

  const { droppedCount, ...selection } = sanitizeSelection(
    await aiSelectReportItems({
      emailAccount,
      candidates,
      replyItems,
      memories: dedupeMemories(reads.flatMap((read) => read.memories)),
      now,
      timeZone,
    }),
    { candidates, replyItems },
  );

  if (droppedCount) {
    logger.warn("Morning report model returned unknown item IDs", {
      droppedCount,
      kept: selection.items.length,
    });
  }

  const text = renderMorningReport({
    now,
    timeZone,
    since,
    previousRunMissed:
      now.getTime() - since.getTime() > MISSED_RUN_THRESHOLD_MS,
    selection,
    selectionFailed: droppedCount > 0 && selection.items.length === 0,
    candidates,
    replyItems,
    events: reads.flatMap((read) => read.events),
    bulkCounts: mergeCounts(reads.map((read) => read.candidates.bulkCounts)),
    staleReplyCount: reads.reduce(
      (sum, read) => sum + read.replies.staleCount,
      0,
    ),
    unverifiedReplyCount: reads.reduce(
      (sum, read) => sum + read.replies.unverifiedCount,
      0,
    ),
    problems,
    failures,
    truncatedAccounts: reads
      .filter((read) => read.candidates.truncated)
      .map((read) => read.accountEmail),
    baseUrl: env.NEXT_PUBLIC_BASE_URL,
  });

  return {
    text,
    since,
    accounts: emailAccounts.map(({ id, email }) => ({
      emailAccountId: id,
      email,
    })),
    failures,
    readEmailAccountIds: reads.map((read) => read.emailAccountId),
  };
}

export async function getReportWindowStart({
  emailAccountId,
  now,
}: {
  emailAccountId: string;
  now: Date;
}) {
  const defaultStart = new Date(now.getTime() - ONE_DAY_MS);
  const lastSent = await redis.get<string>(lastSentKey(emailAccountId));
  if (!lastSent) return defaultStart;
  const sentAt = new Date(lastSent).getTime();
  if (Number.isNaN(sentAt)) return defaultStart;
  return new Date(
    Math.min(now.getTime(), Math.max(sentAt, now.getTime() - MAX_WINDOW_MS)),
  );
}

export async function markReportSent({
  emailAccountIds,
  at,
}: {
  emailAccountIds: string[];
  at: Date;
}) {
  // No TTL: this is the window's anchor, and losing it after a long outage
  // would silently shrink the next report to 24h.
  await Promise.all(
    emailAccountIds.map((id) => redis.set(lastSentKey(id), at.toISOString())),
  );
}

type MailboxRead = Awaited<ReturnType<typeof readMailbox>>;

async function readMailbox({
  emailAccountId,
  accountEmail,
  providerName,
  accountIndex,
  since,
  now,
  timeZone,
  logger,
}: {
  emailAccountId: string;
  accountEmail: string;
  providerName: string;
  accountIndex: number;
  since: Date;
  now: Date;
  timeZone: string;
  logger: Logger;
}) {
  const provider = await createEmailProvider({
    emailAccountId,
    provider: providerName,
    logger,
  });

  const [candidates, replies, events, context] = await Promise.all([
    collectCandidates({
      accountIndex,
      accountEmail,
      emailAccountId,
      provider,
      since,
    }),
    collectReplyState({
      accountIndex,
      accountEmail,
      emailAccountId,
      provider,
      now,
      logger,
    }),
    fetchTodayEvents({ emailAccountId, timeZone, now, logger }).catch(
      (error) => {
        logger.warn("Morning report calendar read failed", { error });
        return [];
      },
    ),
    loadAgentContext({
      emailAccountId,
      provider: providerName,
      surface: "morning report",
      query: MEMORY_QUERY,
      logger,
    }),
  ]);

  return {
    emailAccountId,
    accountEmail,
    since,
    candidates,
    replies,
    events: events.map((event) => ({ accountEmail, event })),
    memories: context.memories,
  };
}

function dedupeMemories(memories: AgentMemory[]) {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    const key = memory.content.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeCounts(counts: Record<string, number>[]) {
  const merged: Record<string, number> = {};
  for (const count of counts) {
    for (const [name, value] of Object.entries(count))
      merged[name] = (merged[name] ?? 0) + value;
  }
  return merged;
}

function lastSentKey(emailAccountId: string) {
  return `morning-report:last-sent:${emailAccountId}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Timed out reading mailbox")),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
