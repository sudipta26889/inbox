import uniqBy from "lodash/uniqBy";
import { NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { GmailLabel } from "@/utils/gmail/label";
import { captureException } from "@/utils/error";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import { classifyEmailAccountProviderIssue } from "@/utils/email/provider-health";
import {
  HistoryEventType,
  type ProcessHistoryOptions,
} from "@/app/api/google/webhook/types";
import { processHistoryItem } from "@/app/api/google/webhook/process-history-item";
import { getHistory } from "@/utils/gmail/history";
import {
  validateWebhookAccount,
  getWebhookEmailAccount,
  type ValidatedWebhookAccountData,
} from "@/utils/webhook/validate-webhook-account";
import {
  getEmailProviderRateLimitState,
  withRateLimitRecording,
} from "@/utils/email/rate-limit";
import prisma from "@/utils/prisma";
import { MessageInFlightError } from "@/utils/redis/message-processing";
import {
  clearGmailHistoryCatchUp,
  isGmailHistoryCatchUpPending,
  markGmailHistoryCatchUp,
} from "@/utils/redis/gmail-history-catch-up";
import type { Logger } from "@/utils/logger";
import type { gmail_v1 } from "@googleapis/gmail";

const MAX_GMAIL_HISTORY_ID_GAP = 500;
// History skipped while Gmail rate limited the account is mail the user is
// still waiting on, so it gets a wider window than a long-disconnected account.
const MAX_GMAIL_CATCH_UP_HISTORY_ID_GAP = 30_000;

export async function processHistoryForUser(
  decodedData: {
    emailAddress: string;
    historyId: number;
  },
  options: { startHistoryId?: string },
  logger: Logger,
) {
  const { emailAddress, historyId } = decodedData;
  // All emails in the database are stored in lowercase
  // But it's possible that the email address in the webhook is not
  // So we need to convert it to lowercase
  const email = emailAddress.toLowerCase();

  const emailAccount = await getWebhookEmailAccount({ email }, logger);

  // biome-ignore lint/style/noParameterAssign: allowed for logging
  logger = logger.with({ email, emailAccountId: emailAccount?.id });

  const validation = await validateWebhookAccount(emailAccount, logger);

  if (!validation.success) {
    return validation.response;
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

  if (
    !validatedEmailAccount.account?.access_token ||
    !validatedEmailAccount.account?.refresh_token
  ) {
    logger.error("Missing tokens after validation");
    return NextResponse.json({ error: true });
  }

  const accountAccessToken = validatedEmailAccount.account.access_token;
  const accountRefreshToken = validatedEmailAccount.account.refresh_token;
  const accountProvider = validatedEmailAccount.account.provider || "google";

  try {
    let activeRateLimit: Awaited<
      ReturnType<typeof getEmailProviderRateLimitState>
    > = null;
    try {
      activeRateLimit = await getEmailProviderRateLimitState({
        emailAccountId: validatedEmailAccount.id,
        logger,
      });
    } catch (error) {
      logger.warn("Failed to read provider rate-limit state for webhook", {
        error: error instanceof Error ? error.message : error,
      });
    }

    if (activeRateLimit?.provider === "google") {
      await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
      logger.warn(
        "Skipping webhook processing due to active Gmail rate limit",
        {
          retryAt: activeRateLimit.retryAt.toISOString(),
          rateLimitSource: activeRateLimit.source,
        },
      );
      return NextResponse.json({ ok: true });
    }

    return await withRateLimitRecording(
      {
        emailAccountId: validatedEmailAccount.id,
        provider: "google",
        logger,
        source: "google/webhook",
        onRateLimitRecorded: async (state, error) => {
          if (
            state ||
            isEmailProviderRateLimitError({ error, provider: "google" })
          ) {
            await markGmailHistoryCatchUp(validatedEmailAccount.id, logger);
          }
        },
      },
      async () => {
        const gmail = await getGmailClientWithRefresh({
          accessToken: accountAccessToken,
          refreshToken: accountRefreshToken,
          expiresAt:
            validatedEmailAccount.account.expires_at?.getTime() || null,
          emailAccountId: validatedEmailAccount.id,
          logger,
        });

        const isCatchUp = await isGmailHistoryCatchUpPending(
          validatedEmailAccount.id,
          logger,
        );

        const historyResult = await fetchGmailHistoryResilient({
          gmail,
          emailAccount: validatedEmailAccount,
          webhookHistoryId: historyId,
          maxHistoryIdGap: isCatchUp
            ? MAX_GMAIL_CATCH_UP_HISTORY_ID_GAP
            : MAX_GMAIL_HISTORY_ID_GAP,
          options,
          logger,
        });

        if (historyResult.status === "expired") {
          await updateLastSyncedHistoryId({
            emailAccountId: validatedEmailAccount.id,
            lastSyncedHistoryId: historyId.toString(),
          });
          if (isCatchUp) {
            await clearGmailHistoryCatchUp(validatedEmailAccount.id, logger);
          }
          return NextResponse.json({ ok: true });
        }

        const history = historyResult.data;
        const historyEntries = history.history ?? [];

        if (historyEntries.length > 0) {
          logger.info("Processing history", {
            startHistoryId: historyResult.startHistoryId,
          });

          const completed = await processHistory(
            {
              history: historyEntries,
              gmail,
              accessToken: accountAccessToken,
              hasAutomationRules,
              hasAiAccess: userHasAiAccess,
              rules: validatedEmailAccount.rules,
              emailAccount: {
                ...validatedEmailAccount,
                account: {
                  provider: accountProvider,
                },
              },
            },
            logger,
          );
          // Keep the wider catch-up window so the retry reaches the unprocessed mail.
          if (!completed) return NextResponse.json({ ok: true });
        } else {
          // When we truncate a large gap (webhookHistoryId - 500), Gmail can return
          // an empty recent window. We still need to advance to the webhook historyId
          // so we don't stay permanently behind and keep skipping.
          logger.info("No history", {
            startHistoryId: historyResult.startHistoryId,
          });

          // important to save this or we can get into a loop with never receiving history
          await updateLastSyncedHistoryId({
            emailAccountId: validatedEmailAccount.id,
            lastSyncedHistoryId: historyId.toString(),
          });
        }

        // Only the first page is fetched, so a catch-up with more pages keeps
        // its wide window for the next webhook.
        if (isCatchUp && !history.nextPageToken) {
          await clearGmailHistoryCatchUp(validatedEmailAccount.id, logger);
        }

        return NextResponse.json({ ok: true });
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_grant") {
      logger.warn("Invalid grant", { email });
      return NextResponse.json({ ok: true });
    }

    captureException(error, { userEmail: email, extra: { decodedData } });
    logger.error("Error processing webhook", {
      error:
        error instanceof Error
          ? {
              message: error.message,
              stack: error.stack,
              name: error.name,
            }
          : error,
    });
    // returning 200 here, as otherwise PubSub will call the webhook over and over
    return NextResponse.json({ error: true });
  }
}

async function processHistory(
  options: ProcessHistoryOptions,
  logger: Logger,
): Promise<boolean> {
  const { history, emailAccount } = options;
  const { email: userEmail, id: emailAccountId } = emailAccount;

  if (!history?.length) return true;

  for (const h of history) {
    const historyMessages = [
      ...(h.messagesAdded || []),
      ...(h.labelsAdded || []),
      ...(h.labelsRemoved || []),
    ];

    if (!historyMessages.length) continue;

    const allEvents = [
      ...(h.messagesAdded || [])
        .filter((m) => {
          const isRelevant = isInboxOrSentMessage(m);
          if (!isRelevant) {
            logger.info("Skipping message not in inbox or sent", {
              messageId: m.message?.id,
              labelIds: m.message?.labelIds,
            });
          }
          return isRelevant;
        })
        .map((m) => ({ type: HistoryEventType.MESSAGE_ADDED, item: m })),
      ...(h.labelsAdded || []).map((m) => ({
        type: HistoryEventType.LABEL_ADDED,
        item: m,
      })),
      ...(h.labelsRemoved || []).map((m) => ({
        type: HistoryEventType.LABEL_REMOVED,
        item: m,
      })),
    ];

    const uniqueEvents = uniqBy(
      allEvents,
      (e) => `${e.type}:${e.item.message?.id}`,
    );

    for (const event of uniqueEvents) {
      const log = logger.with({
        messageId: event.item.message?.id,
        threadId: event.item.message?.threadId,
      });

      try {
        await processHistoryItem(event, options, log);
      } catch (error) {
        // Another run holds this message (or was killed holding it). Stop here
        // so the pointer stays before it; a later webhook retries the entry.
        if (error instanceof MessageInFlightError) {
          logger.info("Stopping history processing: message in flight");
          return false;
        }
        // Stop before the pointer passes mail Gmail refused to serve, so the
        // catch-up after the rate limit picks it up again.
        if (isEmailProviderRateLimitError({ error, provider: "google" })) {
          throw error;
        }
        // Every remaining item would fail the same way once the account needs
        // reconnecting or was deleted mid-run, so stop and keep the pointer.
        const providerIssue = classifyEmailAccountProviderIssue({
          error,
          provider: "google",
        });
        if (providerIssue) {
          logger.warn("Stopping history processing: account unavailable", {
            reason: providerIssue.reason,
          });
          return false;
        }
        // Any other failure (e.g. an LLM error) is logged and the pointer
        // still moves past it: that item's rule run is lost, as upstream.
        captureException(error, {
          userEmail,
          extra: { messageId: event.item.message?.id },
        });
        logger.error("Error processing history item", { error });
      }
    }

    // A catch-up can outlast the function timeout, so keep the progress made.
    await updateLastSyncedHistoryId({
      emailAccountId,
      lastSyncedHistoryId: h.id,
    });
  }

  // Entries with no message events are skipped above, so advance past them too.
  await updateLastSyncedHistoryId({
    emailAccountId,
    lastSyncedHistoryId: history[history.length - 1].id,
  });

  return true;
}

/**
 * Updates lastSyncedHistoryId using a monotonic/conditional update to prevent
 * race conditions where concurrent webhook processors might regress the pointer.
 * Only updates if the new value is greater than the current value.
 */
async function updateLastSyncedHistoryId({
  emailAccountId,
  lastSyncedHistoryId,
}: {
  emailAccountId: string;
  lastSyncedHistoryId?: string | null;
}) {
  if (!lastSyncedHistoryId) return;

  // Use conditional update: only set if new value > current value (or current is null)
  // This prevents race conditions where slower webhook processors with older
  // history IDs could overwrite progress from faster processors with newer IDs
  await prisma.$executeRaw`
    UPDATE "EmailAccount"
    SET "lastSyncedHistoryId" = ${lastSyncedHistoryId}, "updatedAt" = NOW()
    WHERE id = ${emailAccountId}
    AND (
      "lastSyncedHistoryId" IS NULL
      OR CAST("lastSyncedHistoryId" AS NUMERIC) < CAST(${lastSyncedHistoryId} AS NUMERIC)
    )
  `;
}

const isInboxOrSentMessage = (message: {
  message?: { labelIds?: string[] | null };
}) => {
  const labels = message.message?.labelIds;

  if (!labels) return false;

  if (labels.includes(GmailLabel.INBOX) && !labels.includes(GmailLabel.DRAFT))
    return true;

  if (labels.includes(GmailLabel.SENT)) return true;

  return false;
};

function isHistoryIdExpiredError(error: unknown): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: simple
  const err = error as any;
  const statusCode =
    err.response?.data?.error?.code ??
    err.response?.status ??
    err.status ??
    err.code;

  return statusCode === 404;
}

/**
 * Fetches history from Gmail with resilience:
 * 1. Limits how far back we go to avoid processing massive gaps (e.g. if a user is disconnected for months).
 * 2. Handles expired history IDs (404s) by resetting the sync point.
 */
async function fetchGmailHistoryResilient({
  gmail,
  emailAccount,
  webhookHistoryId,
  maxHistoryIdGap,
  options,
  logger,
}: {
  gmail: gmail_v1.Gmail;
  emailAccount: ValidatedWebhookAccountData;
  webhookHistoryId: number;
  maxHistoryIdGap: number;
  options: { startHistoryId?: string };
  logger: Logger;
}): Promise<
  | {
      status: "success";
      data: Awaited<ReturnType<typeof getHistory>>;
      startHistoryId: string;
    }
  | { status: "expired" }
> {
  const lastSyncedHistoryId = Number.parseInt(
    emailAccount?.lastSyncedHistoryId || "0",
  );

  // If the gap is too large, we start from webhookHistoryId - maxHistoryIdGap.
  // This prevents timeouts and runaway processing costs if the system falls way behind.
  const startHistoryIdNum = Math.max(
    lastSyncedHistoryId,
    webhookHistoryId - maxHistoryIdGap,
  );
  const startHistoryId =
    options?.startHistoryId || startHistoryIdNum.toString();

  // Log if we are intentionally skipping emails to keep the system stable
  if (startHistoryIdNum > lastSyncedHistoryId && !options?.startHistoryId) {
    logger.warn("Skipping history items due to large gap", {
      lastSyncedHistoryId,
      webhookHistoryId,
      effectiveStartHistoryId: startHistoryIdNum,
      skippedHistoryItems: startHistoryIdNum - lastSyncedHistoryId,
      maxHistoryIdGap,
    });
  }

  logger.info("Listing history", {
    startHistoryId,
    lastSyncedHistoryId: emailAccount?.lastSyncedHistoryId,
    gmailHistoryId: startHistoryId,
  });

  try {
    const data = await getHistory(
      gmail,
      {
        startHistoryId,
        historyTypes: ["messageAdded", "labelAdded", "labelRemoved"],
        maxResults: 500,
      },
      logger,
    );

    if (data.nextPageToken) {
      logger.warn("Gmail history has more pages that were not fetched", {
        historyItemCount: data.history?.length ?? 0,
        startHistoryId,
      });
    }

    return { status: "success", data, startHistoryId };
  } catch (error) {
    // Gmail history IDs are typically valid for ~1 week. If older, Gmail returns a 404.
    // In this case, we reset the sync point to the current history ID.
    if (isHistoryIdExpiredError(error)) {
      logger.warn("HistoryId expired, resetting to current", {
        expiredHistoryId: startHistoryId,
        newHistoryId: webhookHistoryId,
      });
      return { status: "expired" };
    }
    throw error;
  }
}
