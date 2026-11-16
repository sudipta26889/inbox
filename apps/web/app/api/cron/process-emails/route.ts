import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { getInboxStatsForChatContext } from "@/utils/ai/assistant/get-inbox-stats-for-chat-context";
import { isMqttConfigured } from "@/utils/mqtt/client";
import { publishUnread } from "@/utils/mqtt/events";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { getPremiumUserFilter } from "@/utils/premium";

export const maxDuration = 800;

const BATCH_SIZE = 100;

// Polling backup to Gmail push (deploy/stack.yml runs it every 30 minutes).
export const GET = withError("cron/process-emails", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized request: api/cron/process-emails"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return NextResponse.json(await enqueueEmailProcessingJobs(request.logger));
});

export const POST = withError("cron/process-emails", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/process-emails"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  return NextResponse.json(await enqueueEmailProcessingJobs(request.logger));
});

async function enqueueEmailProcessingJobs(logger: Logger) {
  // Every connected mailbox; the worker's validateWebhookAccount decides the
  // rest. The premium filter is a no-op with the bypass on (always, per
  // strip-guard). An image built without it then shows "total: 0" here instead
  // of the worker unwatching every mailbox each run.
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      account: {
        disconnectedAt: null,
        provider: { in: ["google", "microsoft"] },
      },
      ...getPremiumUserFilter(),
    },
    select: { id: true, account: { select: { provider: true } } },
    take: BATCH_SIZE,
  });

  let queued = 0;
  let failed = 0;

  for (const { id: emailAccountId, account } of emailAccounts) {
    const accountLogger = logger.with({ emailAccountId });
    try {
      const dispatchMode = await enqueueBackgroundJob({
        topic: "process-emails-account",
        body: { emailAccountId },
        qstash: {
          queueName: "process-emails",
          parallelism: 5,
          path: "/api/process-emails",
        },
        logger: accountLogger,
      });
      accountLogger.info("Queued email account for processing", {
        dispatchMode,
      });
      queued += 1;

      await publishUnreadStats({
        emailAccountId,
        provider: account?.provider || "google",
        logger: accountLogger,
      });
    } catch (error) {
      failed += 1;
      accountLogger.error("Failed to enqueue email account for processing", {
        error,
      });
    }
  }

  const result = { total: emailAccounts.length, queued, failed };
  logger.info("Finished enqueueing email accounts for processing", result);
  return result;
}

/**
 * Best-effort MQTT publish for one account's unread count.
 *
 * Exported so this can be tested in isolation: this call site runs inside the
 * same per-account try/catch as `enqueueBackgroundJob` and the `queued`
 * counter above — a throw here would double-count the account as both queued
 * and failed, logged under a misleading label. Every exit is fail-soft on
 * purpose; nothing here may reject.
 */
export async function publishUnreadStats({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}): Promise<void> {
  // Skip the provider round trip entirely when MQTT isn't configured on this
  // instance at all — no point paying for inbox stats nobody can consume.
  // Per-account consent is still resolved inside publishUnread.
  if (!isMqttConfigured()) return;

  const stats = await getInboxStatsForChatContext({
    emailAccountId,
    provider,
    logger,
  });

  if (!stats) return;

  await publishUnread({
    emailAccountId,
    unread: stats.unread,
    total: stats.total,
  }).catch(() => {});
}
