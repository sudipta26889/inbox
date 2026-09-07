import { sendAutomationMessage } from "@/utils/automation-jobs/messaging";
import {
  isAutomationMessagingChannelReady,
  SUPPORTED_AUTOMATION_MESSAGING_PROVIDERS,
} from "@/utils/automation-jobs/messaging-channel";
import type { Logger } from "@/utils/logger";
import { notifyOwner } from "@/utils/ntfy";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

/**
 * Make the 05:00 digest report its own outcome.
 *
 * The cron container invokes the route as `curl ... || true`, so the exit
 * status and the response body — including `failed: 1` — are discarded. A run
 * that dies leaves nothing behind but a line in container logs nobody reads,
 * which is indistinguishable from a run that never fired.
 *
 * Two records, because they answer different questions:
 *   - a Redis row you can query any time ("did it run, and what happened?")
 *   - a message on the owner's chat channel when it FAILS ("something needs me")
 * Success is intentionally silent — the digest itself is the success signal.
 */

const LAST_RUN_TTL_SECONDS = 60 * 60 * 24 * 14;

export type DigestRunOutcome = {
  status: "ok" | "failed";
  date: string;
  at: string;
  accounts?: number;
  failedAccounts?: string[];
  error?: string;
};

export async function recordDigestRun({
  userId,
  outcome,
}: {
  userId: string;
  outcome: DigestRunOutcome;
}) {
  await redis.set(`a2a-digest:last-run:${userId}`, outcome, {
    ex: LAST_RUN_TTL_SECONDS,
  });
}

export async function getLastDigestRun(userId: string) {
  return redis.get<DigestRunOutcome>(`a2a-digest:last-run:${userId}`);
}

/**
 * Tell the owner on the chat channel they already use for check-ins.
 * Best-effort: an alert that throws must not mask the failure it describes.
 */
export async function alertDigestFailure({
  userId,
  outcome,
  logger,
}: {
  userId: string;
  outcome: DigestRunOutcome;
  logger: Logger;
}) {
  try {
    const failedAccounts = outcome.failedAccounts?.length
      ? `\nAccounts affected: ${outcome.failedAccounts.join(", ")}`
      : "";

    // First, unconditionally: this needs no per-user channel setup, which is
    // exactly the case the Telegram path below gives up on. Only owners reach
    // this function — runDueDigests filters on isAdmin before calling it.
    await notifyOwner({
      title: "Morning digest failed",
      message: `${outcome.date}: ${outcome.error ?? "Unknown error"}${failedAccounts}`,
      priority: 4,
      tags: ["warning"],
    });

    const channel = await prisma.messagingChannel.findFirst({
      where: {
        isConnected: true,
        provider: { in: SUPPORTED_AUTOMATION_MESSAGING_PROVIDERS },
        emailAccount: { userId },
      },
      select: {
        provider: true,
        accessToken: true,
        providerUserId: true,
        channelId: true,
        isConnected: true,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!channel || !isAutomationMessagingChannelReady(channel)) {
      logger.warn("No messaging channel to report digest failure on", {
        userId,
      });
      return;
    }

    await sendAutomationMessage({
      channel,
      text: `Morning digest failed for ${outcome.date}.\n${outcome.error ?? "Unknown error"}${failedAccounts}\n\nNothing was sent to your agents. The next scheduled run will retry.`,
      logger,
    });
  } catch (error) {
    // Never let the alert path throw over the original failure.
    logger.error("Failed to report digest failure", { userId, error });
  }
}
