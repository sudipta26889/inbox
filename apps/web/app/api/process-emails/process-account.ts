import type { gmail_v1 } from "@googleapis/gmail";
import { captureException, isInvalidGrantError } from "@/utils/error";
import { redis } from "@/utils/redis";
import {
  validateWebhookAccount,
  webhookEmailAccountSelect,
} from "@/utils/webhook/validate-webhook-account";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { withGmailRetry } from "@/utils/gmail/retry";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { logErrorWithDedupe } from "@/utils/log-error-with-dedupe";
import { GmailLabel } from "@/utils/gmail/label";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import { withMessageProcessingLock } from "@/utils/redis/message-processing";
import {
  forgetLlmRetry,
  getLlmRetryEntries,
  getLlmRetryMaxAgeMs,
  rememberLlmRetry,
} from "@/utils/redis/llm-retry";
import { isLlmUnavailableError } from "@/utils/llms";
import { processRecentSentMessages } from "./process-sent";

const BATCH_SIZE = 50;

// Backup to Gmail push: every 30 minutes the cron enqueues each account here,
// and this processes unread inbox mail that has no ExecutedRule yet.
export async function processEmailsForAccount({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<{ success: boolean; processed?: number; skipped?: number }> {
  const lockKey = `process-emails:${emailAccountId}`;
  let locked = false;

  try {
    locked = (await redis.set(lockKey, "1", { nx: true, ex: 600 })) === "OK";

    if (!locked) {
      logger.info("Already processing emails for this account");
      return { success: false };
    }

    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: webhookEmailAccountSelect,
    });

    if (!emailAccount) {
      logger.error("Email account not found");
      return { success: false };
    }

    logger = logger.with({ email: emailAccount.email });

    const validation = await validateWebhookAccount(emailAccount, logger);

    if (!validation.success) {
      logger.info("Account validation failed");
      return { success: false };
    }

    const {
      emailAccount: validatedEmailAccount,
      hasAutomationRules,
      hasAiAccess: userHasAiAccess,
    } = validation.data;

    const accountProvider = validatedEmailAccount.account?.provider || "google";

    // ponytail: Outlook has no polling backup (same as the fork); its Graph
    // subscription is the only path. Add a delta query if that ever drops mail.
    if (!isGoogleProvider(accountProvider)) {
      logger.info("Skipping polling for non-Gmail account");
      return { success: true };
    }

    if (
      !validatedEmailAccount.account?.access_token ||
      !validatedEmailAccount.account?.refresh_token
    ) {
      logger.error("Missing access or refresh token");
      return { success: false };
    }

    const activeRateLimit = await getEmailProviderRateLimitState({
      emailAccountId: validatedEmailAccount.id,
      logger,
    });
    if (activeRateLimit?.provider === "google") {
      logger.warn("Skipping Gmail polling due to active Gmail rate limit", {
        retryAt: activeRateLimit.retryAt.toISOString(),
      });
      return { success: false };
    }

    const provider = await createEmailProvider({
      emailAccountId: validatedEmailAccount.id,
      provider: accountProvider,
      logger,
    });

    const gmail = await getGmailClientWithRefresh({
      accessToken: validatedEmailAccount.account.access_token,
      refreshToken: validatedEmailAccount.account.refresh_token,
      expiresAt: validatedEmailAccount.account.expires_at?.getTime() || null,
      emailAccountId: validatedEmailAccount.id,
      logger,
    });

    const processOptions = {
      provider,
      rules: validatedEmailAccount.rules,
      hasAutomationRules,
      hasAiAccess: userHasAiAccess,
      emailAccount: validatedEmailAccount,
      logger,
    };

    // Best-effort: a sent-mail failure must never block inbox processing.
    try {
      const sentProcessed = await processRecentSentMessages({
        gmail,
        emailAccountId: validatedEmailAccount.id,
        options: processOptions,
        logger,
      });
      if (sentProcessed) {
        logger.info("Processed recent sent messages", {
          count: sentProcessed,
        });
      }
    } catch (error) {
      logger.error("Sent-mail catch-up failed", { error });
    }

    const response = await gmail.users.messages.list({
      userId: "me",
      labelIds: [GmailLabel.INBOX, GmailLabel.UNREAD],
      maxResults: BATCH_SIZE,
    });

    const messages = (response.data.messages || []).filter(
      (m): m is { id: string; threadId?: string | null } => !!m.id,
    );
    logger.info("Found unread emails in inbox", { count: messages.length });

    const processedMessages = messages.length
      ? await prisma.executedRule.findMany({
          where: {
            emailAccountId: validatedEmailAccount.id,
            messageId: { in: messages.map((m) => m.id) },
          },
          select: { messageId: true },
        })
      : [];
    const processedMessageIds = new Set(
      processedMessages.map((m) => m.messageId),
    );
    const unprocessedMessages = messages.filter(
      (m) => !processedMessageIds.has(m.id),
    );

    let processed = 0;
    let skipped = 0;

    // Same lock as the webhook, so an overlapping run processes it once.
    // Any held lock is a skip here: polling never moves the history pointer.
    const processMessage = async (
      message: { id: string; threadId?: string | null },
      isModelRetry = false,
    ): Promise<"processed" | "skipped" | "failed"> => {
      const messageLogger = logger.with({ messageId: message.id });
      try {
        const result = await withMessageProcessingLock(
          { userEmail: validatedEmailAccount.email, messageId: message.id },
          () =>
            processHistoryItem(
              {
                messageId: message.id,
                threadId: message.threadId ?? undefined,
              },
              {
                ...processOptions,
                logger: messageLogger,
                ...(isModelRetry ? { isModelRetry } : {}),
              },
            ),
        );

        if (result.skipped) {
          messageLogger.info("Skipping. Message already being processed.");
          return "skipped";
        }
        return "processed";
      } catch (error) {
        messageLogger.error("Failed to process message", { error });
        if (isLlmUnavailableError(error)) {
          await rememberLlmRetry({
            emailAccountId: validatedEmailAccount.id,
            messageId: message.id,
            logger: messageLogger,
          });
        }
        return "failed";
      }
    };

    // Read after the list, so a message this run fails on is not retried in it.
    const retryCandidates = await getMessagesToRetry({
      emailAccountId: validatedEmailAccount.id,
      alreadyInRun: new Set(messages.map((m) => m.id)),
      logger,
    });

    for (const message of unprocessedMessages) {
      const outcome = await processMessage(message);
      if (outcome === "processed") processed += 1;
      else skipped += 1;
    }

    let retried = 0;
    const retryReturned: string[] = [];
    for (const message of retryCandidates) {
      retried += 1;
      const outcome = await processMessage({ id: message.messageId }, true);
      if (outcome === "processed") retryReturned.push(message.messageId);
      else skipped += 1;
    }

    // "Processed" only means the pipeline returned; an early return (no AI
    // access, unsubscribed sender, ...) writes no ExecutedRule. Only mail with
    // one counts as succeeded; the rest is forgotten and reported as dropped.
    const retryRuleRows = retryReturned.length
      ? await prisma.executedRule.findMany({
          where: {
            emailAccountId: validatedEmailAccount.id,
            messageId: { in: retryReturned },
          },
          select: { messageId: true },
        })
      : [];
    const retryHandled = new Set(retryRuleRows.map((row) => row.messageId));
    const retrySucceededIds = retryReturned.filter((id) =>
      retryHandled.has(id),
    );
    const retryDroppedIds = retryReturned.filter((id) => !retryHandled.has(id));
    processed += retrySucceededIds.length;
    skipped += retryDroppedIds.length;

    if (retryReturned.length) {
      await forgetLlmRetry({
        emailAccountId: validatedEmailAccount.id,
        messageIds: retryReturned,
        logger,
      });
    }
    if (retryDroppedIds.length) {
      logger.warn(
        "Retried mail returned with no ExecutedRule; no longer retrying",
        { messageIds: retryDroppedIds },
      );
    }
    if (retried) {
      logger.info("Retried mail that failed while the model was offline", {
        retried,
        succeeded: retrySucceededIds.length,
        dropped: retryDroppedIds.length,
      });
    }

    if (!emailAccount.lastSyncedHistoryId) {
      await healNullHistoryPointer(validatedEmailAccount.id, gmail);
    }

    logger.info("Gmail inbox processing completed", {
      processed,
      skipped,
      total: unprocessedMessages.length,
    });

    return { success: true, processed, skipped };
  } catch (error) {
    // The Gmail client already disconnected the account on a revoked grant.
    if (isInvalidGrantError(error)) {
      logger.warn("Invalid grant");
      return { success: false };
    }

    captureException(error, { emailAccountId });
    await logErrorWithDedupe({
      logger,
      message: "Error processing emails for account",
      error,
      context: { emailAccountId },
      dedupeKeyParts: {
        scope: "process-emails",
        emailAccountId,
        operation: "process-account",
      },
    });

    return { success: false };
  } finally {
    if (locked) {
      try {
        await redis.del(lockKey);
      } catch (error) {
        logger.error("Error releasing processing lock", { error });
      }
    }
  }
}

// The webhook owns the history pointer and stops it before mail it could not
// process. Writing Gmail's current ID here would skip that mail, so polling
// only seeds a missing pointer.
async function healNullHistoryPointer(
  emailAccountId: string,
  gmail: gmail_v1.Gmail,
) {
  const profile = await withGmailRetry(() =>
    gmail.users.getProfile({ userId: "me" }),
  );
  const historyId = profile.data.historyId;
  if (!historyId) throw new Error("No historyId found in Gmail profile");

  await prisma.emailAccount.updateMany({
    where: { id: emailAccountId, lastSyncedHistoryId: null },
    data: { lastSyncedHistoryId: historyId },
  });
}

// Mail that failed because the model was offline, including mail read since.
async function getMessagesToRetry({
  emailAccountId,
  alreadyInRun,
  logger,
}: {
  emailAccountId: string;
  alreadyInRun: Set<string>;
  logger: Logger;
}) {
  const remembered = await getLlmRetryEntries({ emailAccountId, logger });
  if (!remembered.length) return [];

  const cutoff = Date.now() - getLlmRetryMaxAgeMs();
  const expired = remembered.filter((entry) => entry.firstFailedAt < cutoff);
  const fresh = remembered.filter(
    (entry) =>
      entry.firstFailedAt >= cutoff && !alreadyInRun.has(entry.messageId),
  );

  const alreadyHandled = fresh.length
    ? await prisma.executedRule.findMany({
        where: {
          emailAccountId,
          messageId: { in: fresh.map((entry) => entry.messageId) },
        },
        select: { messageId: true },
      })
    : [];
  const handledIds = new Set(alreadyHandled.map((entry) => entry.messageId));

  const dropIds = [
    ...expired.map((entry) => entry.messageId),
    ...[...handledIds],
  ];
  if (expired.length) {
    logger.warn("Dropping mail that waited over 72 hours for the model", {
      count: expired.length,
    });
  }
  await forgetLlmRetry({ emailAccountId, messageIds: dropIds, logger });

  const toRetry = fresh
    .filter((entry) => !handledIds.has(entry.messageId))
    .slice(0, BATCH_SIZE);
  logger.info("Mail waiting for the model", {
    remembered: remembered.length,
    expired: expired.length,
    toRetry: toRetry.length,
  });
  return toRetry;
}
