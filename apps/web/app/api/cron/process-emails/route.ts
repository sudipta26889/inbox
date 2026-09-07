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
import { hasAiAccess, getPremiumUserFilter } from "@/utils/premium";

export const maxDuration = 800;

const BATCH_SIZE = 100;
const PROCESS_EMAILS_TOPIC = "process-emails-account";

export const GET = withError("cron/process-emails", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(
      new Error("Unauthorized request: api/cron/process-emails"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await enqueueEmailProcessingJobs(request.logger);
  return NextResponse.json(result);
});

export const POST = withError("cron/process-emails", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/cron/process-emails"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await enqueueEmailProcessingJobs(request.logger);
  return NextResponse.json(result);
});

async function enqueueEmailProcessingJobs(logger: Logger) {
  // Find all email accounts that need email processing
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      // Account must be active (not disconnected)
      account: {
        disconnectedAt: null,
        provider: {
          in: ["google", "microsoft"],
        },
      },
      // Must have premium access with AI enabled
      ...getPremiumUserFilter(),
      // Must have at least one automation feature enabled
      OR: [
        // Has automation rules enabled
        {
          rules: {
            some: {
              enabled: true,
            },
          },
        },
        // Has auto-learn patterns enabled
        { autoLearnPatterns: true },
        // Has auto-categorize senders enabled
        { autoCategorizeSenders: true },
      ],
    },
    select: {
      id: true,
      email: true,
      userId: true,
      autoLearnPatterns: true,
      autoCategorizeSenders: true,
      account: {
        select: {
          provider: true,
        },
      },
      user: {
        select: {
          aiApiKey: true,
          premium: {
            select: {
              tier: true,
              lemonSqueezyRenewsAt: true,
              stripeSubscriptionStatus: true,
            },
          },
        },
      },
      _count: {
        select: {
          rules: {
            where: { enabled: true },
          },
        },
      },
    },
    take: BATCH_SIZE,
  });

  logger.info("Found email accounts for processing", {
    count: emailAccounts.length,
  });

  let queued = 0;
  let skipped = 0;
  let failed = 0;

  for (const account of emailAccounts) {
    const accountLogger = logger.with({
      emailAccountId: account.id,
      email: account.email,
    });

    try {
      // Verify AI access
      const userHasAiAccess = hasAiAccess(
        account.user.premium?.tier || null,
        account.user.aiApiKey || null,
      );

      if (!userHasAiAccess) {
        accountLogger.info("Skipping account without AI access");
        skipped += 1;
        continue;
      }

      // Enqueue the account for processing
      const dispatchMode = await enqueueBackgroundJob({
        topic: PROCESS_EMAILS_TOPIC,
        body: { emailAccountId: account.id },
        qstash: {
          queueName: "process-emails",
          parallelism: 5,
          path: "/api/process-emails",
        },
        logger: accountLogger,
      });

      accountLogger.info("Queued email account for processing", {
        dispatchMode,
        rulesCount: account._count.rules,
        autoLearnPatterns: account.autoLearnPatterns,
        autoCategorizeSenders: account.autoCategorizeSenders,
      });

      queued += 1;

      await publishUnreadStats({
        emailAccountId: account.id,
        provider: account.account?.provider || "google",
        logger: accountLogger,
      });
    } catch (error) {
      failed += 1;
      accountLogger.error("Failed to enqueue email account for processing", {
        error,
      });
    }
  }

  logger.info("Finished enqueueing email accounts for processing", {
    total: emailAccounts.length,
    queued,
    skipped,
    failed,
  });

  return {
    total: emailAccounts.length,
    queued,
    skipped,
    failed,
  };
}

/**
 * Best-effort MQTT publish for one account's unread count.
 *
 * Exported so this can be tested in isolation: this is the one untested call
 * site that ran inside the same per-account try/catch as `enqueueBackgroundJob`
 * and the `queued` counter above — a throw here would double-count the
 * account as both queued and failed, logged under a misleading label. Every
 * exit is fail-soft on purpose; nothing here may reject.
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
