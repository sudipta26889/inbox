import "server-only";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

// Mail that failed because the model was offline. The poll only retries unread
// inbox mail, so without this a message read on the phone in the meantime
// would never be processed. Score = time of the first failure.
const LLM_RETRY_KEY_PREFIX = "llm-retry";
const DEFAULT_RETRY_MAX_AGE_HOURS = 72;
// The queue outlives the retry window, so a model host offline for a weekend still
// finds its queue.
const TTL_MARGIN_HOURS = 24;
const MAX_ENTRIES_READ = 200;

export function getLlmRetryMaxAgeMs() {
  return getRetryMaxAgeHours() * 60 * 60 * 1000;
}

// Failures here only cost a retry, so they never fail the caller.
export async function rememberLlmRetry({
  emailAccountId,
  messageId,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  logger: Logger;
}) {
  try {
    const key = getLlmRetryKey(emailAccountId);
    // NX keeps the first failure time, which the retry window counts from.
    await redis.zaddNx(key, Date.now(), messageId);
    await redis.expire(
      key,
      (getRetryMaxAgeHours() + TTL_MARGIN_HOURS) * 60 * 60,
    );
  } catch (error) {
    logger.warn("Failed to remember message for model retry", { error });
  }
}

/** Oldest first. */
export async function getLlmRetryEntries({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}): Promise<{ messageId: string; firstFailedAt: number }[]> {
  try {
    const entries = await redis.zrangeWithScores(
      getLlmRetryKey(emailAccountId),
      0,
      MAX_ENTRIES_READ - 1,
    );
    return entries.map(({ member, score }) => ({
      messageId: member,
      firstFailedAt: score,
    }));
  } catch (error) {
    logger.warn("Failed to read messages waiting for model retry", { error });
    return [];
  }
}

export async function forgetLlmRetry({
  emailAccountId,
  messageIds,
  logger,
}: {
  emailAccountId: string;
  messageIds: string[];
  logger: Logger;
}) {
  if (!messageIds.length) return;
  try {
    await redis.zrem(getLlmRetryKey(emailAccountId), ...messageIds);
  } catch (error) {
    logger.warn("Failed to clear messages waiting for model retry", { error });
  }
}

function getRetryMaxAgeHours() {
  return env.LLM_RETRY_MAX_AGE_HOURS ?? DEFAULT_RETRY_MAX_AGE_HOURS;
}

function getLlmRetryKey(emailAccountId: string) {
  return `${LLM_RETRY_KEY_PREFIX}:${emailAccountId}`;
}
