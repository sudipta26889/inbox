import * as Sentry from "@sentry/nextjs";
import { captureException } from "@/utils/error";
import { redis } from "@/utils/redis";
import { validateWebhookAccount } from "@/utils/webhook/validate-webhook-account";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getCurrentHistoryId } from "@/utils/gmail/profile";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { logErrorWithDedupe } from "@/utils/log-error-with-dedupe";
import { GmailLabel } from "@/utils/gmail/label";

const BATCH_SIZE = 50; // Process up to 50 emails per run

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
    // Acquire account-level lock to prevent concurrent processing
    locked = (await redis.set(lockKey, "1", { nx: true, ex: 600 })) === "OK";

    if (!locked) {
      logger.info("Already processing emails for this account");
      return { success: false };
    }

    logger.info("Acquired processing lock");

    // Get email account with all necessary fields
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        id: true,
        email: true,
        userId: true,
        about: true,
        multiRuleSelectionEnabled: true,
        timezone: true,
        calendarBookingLink: true,
        draftReplyConfidence: true,
        lastSyncedHistoryId: true,
        autoCategorizeSenders: true,
        autoLearnPatterns: true,
        filingEnabled: true,
        filingPrompt: true,
        watchEmailsSubscriptionId: true,
        watchEmailsSubscriptionHistory: true,
        account: {
          select: {
            provider: true,
            access_token: true,
            refresh_token: true,
            expires_at: true,
            disconnectedAt: true,
          },
        },
        rules: {
          where: { enabled: true },
          include: { actions: true },
        },
        user: {
          select: {
            aiProvider: true,
            aiModel: true,
            aiApiKey: true,
            premium: {
              select: {
                lemonSqueezyRenewsAt: true,
                stripeSubscriptionStatus: true,
                tier: true,
              },
            },
          },
        },
      },
    });

    if (!emailAccount) {
      logger.error("Email account not found");
      return { success: false };
    }

    logger = logger.with({ email: emailAccount.email });

    // Validate the account
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

    Sentry.setTag("emailAccountId", validatedEmailAccount.id);
    Sentry.setUser({
      id: validatedEmailAccount.userId,
      email: validatedEmailAccount.email,
    });

    const accountProvider = validatedEmailAccount.account?.provider || "google";

    logger.info("Processing emails", {
      provider: accountProvider,
      hasAutomationRules,
      hasAiAccess: userHasAiAccess,
    });

    // Create email provider
    const provider = await createEmailProvider({
      emailAccountId: validatedEmailAccount.id,
      provider: accountProvider,
      logger,
    });

    if (isGoogleProvider(accountProvider)) {
      // Gmail processing flow - fetch unread emails from inbox
      logger.info("Fetching unanalyzed emails from Gmail inbox");

      if (
        !validatedEmailAccount.account?.access_token ||
        !validatedEmailAccount.account?.refresh_token
      ) {
        logger.error("Missing access or refresh token");
        return { success: false };
      }

      const gmail = await getGmailClientWithRefresh({
        accessToken: validatedEmailAccount.account.access_token,
        refreshToken: validatedEmailAccount.account.refresh_token,
        expiresAt: validatedEmailAccount.account.expires_at?.getTime() || null,
        emailAccountId: validatedEmailAccount.id,
        logger,
      });

      // Fetch unread emails from inbox
      const response = await gmail.users.messages.list({
        userId: "me",
        labelIds: [GmailLabel.INBOX, GmailLabel.UNREAD],
        maxResults: BATCH_SIZE,
      });

      const messages = response.data.messages || [];
      logger.info("Found unread emails in inbox", { count: messages.length });

      if (messages.length === 0) {
        // Update historyId for future incremental syncs
        const currentHistoryId = await getCurrentHistoryId(gmail);
        await prisma.emailAccount.update({
          where: { id: validatedEmailAccount.id },
          data: { lastSyncedHistoryId: currentHistoryId },
        });

        logger.info("No unread emails to process");
        return { success: true, processed: 0, skipped: 0 };
      }

      // Check which messages have already been processed
      const messageIds = messages.map((m) => m.id!);
      const processedMessages = await prisma.executedRule.findMany({
        where: {
          emailAccountId: validatedEmailAccount.id,
          messageId: { in: messageIds },
        },
        select: { messageId: true },
      });

      const processedMessageIds = new Set(
        processedMessages.map((m) => m.messageId),
      );
      const unprocessedMessages = messages.filter(
        (m) => !processedMessageIds.has(m.id!),
      );

      logger.info("Filtering already processed messages", {
        total: messages.length,
        alreadyProcessed: processedMessageIds.size,
        toProcess: unprocessedMessages.length,
      });

      let processed = 0;
      let skipped = 0;

      // Process each unprocessed message
      for (const message of unprocessedMessages) {
        try {
          const messageLogger = logger.with({ messageId: message.id });

          await processHistoryItem(
            {
              messageId: message.id!,
              threadId: message.threadId,
            },
            {
              provider,
              rules: validatedEmailAccount.rules,
              hasAutomationRules,
              hasAiAccess: userHasAiAccess,
              emailAccount: validatedEmailAccount,
              logger: messageLogger,
            },
          );

          processed += 1;
          messageLogger.info("Processed message successfully");
        } catch (error) {
          skipped += 1;
          logger.error("Failed to process message", {
            messageId: message.id,
            error,
          });
          // Continue processing other messages even if one fails
        }
      }

      // Update historyId after processing
      const currentHistoryId = await getCurrentHistoryId(gmail);
      await prisma.emailAccount.update({
        where: { id: validatedEmailAccount.id },
        data: { lastSyncedHistoryId: currentHistoryId },
      });

      logger.info("Gmail inbox processing completed", {
        processed,
        skipped,
        total: unprocessedMessages.length,
      });

      return { success: true, processed, skipped };
    } else {
      // Outlook processing flow
      logger.info("Processing Outlook account");

      if (!validatedEmailAccount.watchEmailsSubscriptionId) {
        logger.error("Missing watchEmailsSubscriptionId for Outlook account");
        return { success: false };
      }

      // For Outlook, we need to fetch new messages since last sync
      // This is a simplified version - in production you'd want to implement
      // delta queries or similar approach to get new messages
      logger.warn(
        "Outlook polling not fully implemented - webhook-based processing is recommended",
      );

      // Placeholder for Outlook processing
      // You would implement delta sync or similar here
      return { success: true };
    }
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
    // Clean up Redis lock
    if (locked) {
      try {
        await redis.del(lockKey);
        logger.info("Released processing lock");
      } catch (error) {
        logger.error("Error releasing processing lock", { error });
      }
    }
  }
}
