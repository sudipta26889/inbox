import "server-only";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";

const GMAIL_HISTORY_CATCH_UP_KEY_PREFIX = "gmail-history-catch-up";
const GMAIL_HISTORY_CATCH_UP_TTL_SECONDS = 24 * 60 * 60;

// Failures only cost the wider catch-up window, so they never fail the webhook.
// Shares the rate-limit state's Redis check: without that state, webhooks never
// skip history, so there is nothing to catch up on.

/**
 * Records that webhook history was left unprocessed because Gmail was rate
 * limiting the account, so the next webhook reads a wider history window.
 */
export async function markGmailHistoryCatchUp(
  emailAccountId: string,
  logger: Logger,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;

  try {
    await redis.set(getGmailHistoryCatchUpKey(emailAccountId), "1", {
      ex: GMAIL_HISTORY_CATCH_UP_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("Failed to mark Gmail history catch-up", { error });
  }
}

export async function isGmailHistoryCatchUpPending(
  emailAccountId: string,
  logger: Logger,
): Promise<boolean> {
  if (!isEmailProviderRateLimitRedisConfigured()) return false;

  try {
    return (
      (await redis.get(getGmailHistoryCatchUpKey(emailAccountId))) !== null
    );
  } catch (error) {
    logger.warn("Failed to read Gmail history catch-up", { error });
    return false;
  }
}

// ponytail: plain del, not upstream's token compare-and-delete. A webhook
// skipped while a catch-up runs loses its mark; its mail is still inside the
// 500-ID window unless more than 500 history IDs pass first.
export async function clearGmailHistoryCatchUp(
  emailAccountId: string,
  logger: Logger,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;

  try {
    await redis.del(getGmailHistoryCatchUpKey(emailAccountId));
  } catch (error) {
    logger.warn("Failed to clear Gmail history catch-up", { error });
  }
}

function getGmailHistoryCatchUpKey(emailAccountId: string) {
  return `${GMAIL_HISTORY_CATCH_UP_KEY_PREFIX}:${emailAccountId}`;
}
