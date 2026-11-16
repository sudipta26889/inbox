import type { gmail_v1 } from "@googleapis/gmail";
import { captureException } from "@/utils/error";
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

    for (const message of unprocessedMessages) {
      const messageLogger = logger.with({ messageId: message.id });
      try {
        // Same lock as the webhook, so an overlapping run processes it once.
        // Any held lock is a skip here: polling never moves the history pointer.
        const result = await withMessageProcessingLock(
          { userEmail: validatedEmailAccount.email, messageId: message.id },
          () =>
            processHistoryItem(
              { messageId: message.id, threadId: message.threadId ?? undefined },
              { ...processOptions, logger: messageLogger },
            ),
        );

        if (result.skipped) {
          skipped += 1;
          messageLogger.info("Skipping. Message already being processed.");
          continue;
        }
        processed += 1;
      } catch (error) {
        skipped += 1;
        messageLogger.error("Failed to process message", { error });
      }
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
    if (error instanceof Error && error.message === "invalid_grant") {
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
