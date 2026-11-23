import crypto from "node:crypto";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

const MAX_ATTEMPTS_PER_DAY = 3;
const MAX_OWNER_PINGS_PER_DAY = 5;
const REQUEST_TIMEOUT_MS = 30_000;
const STATE_TTL_SECONDS = 2 * 24 * 60 * 60;

export function isMitraDigestConfigured() {
  return Boolean(env.MITRA_OWNER_A2A_URL && env.MITRA_OWNER_A2A_TOKEN);
}

/**
 * Sends the digest as one message to Mitra's owner intake. Mitra does not
 * deduplicate, so a Redis marker per account and date makes this idempotent:
 * set on success only, a 4xx marks the day failed, and a 5xx or timeout
 * leaves the next digest run to retry (3 attempts a day). Each success counts
 * as one of the owner's five pings for that date.
 */
export async function sendDigestToMitra({
  emailAccountId,
  dateKey,
  text,
  logger,
}: {
  emailAccountId: string;
  dateKey: string;
  text: string;
  logger: Logger;
}): Promise<void> {
  const url = env.MITRA_OWNER_A2A_URL;
  const token = env.MITRA_OWNER_A2A_TOKEN;
  if (!url || !token)
    throw new Error("Mitra digest delivery is not configured");

  const sentKey = `digest-mitra:sent:${emailAccountId}:${dateKey}`;
  const failedKey = `digest-mitra:failed:${emailAccountId}:${dateKey}`;
  const attemptsKey = `digest-mitra:attempts:${emailAccountId}:${dateKey}`;
  const pingsKey = `owner-pings:${dateKey}`;
  const contextId = `inbox-digest-${dateKey}`;

  if (await redis.get(sentKey)) {
    logger.info("Digest already sent to Mitra today, skipping", { contextId });
    return;
  }

  if (await redis.get(failedKey)) {
    throw new Error("Mitra rejected today's digest earlier; not retrying");
  }

  const pings = Number((await redis.get(pingsKey)) ?? 0);
  if (pings >= MAX_OWNER_PINGS_PER_DAY) {
    throw new Error(
      `Owner ping ceiling of ${MAX_OWNER_PINGS_PER_DAY} a day reached`,
    );
  }

  const attempts = await redis.incr(attemptsKey);
  if (attempts === 1) await redis.expire(attemptsKey, STATE_TTL_SECONDS);
  if (attempts > MAX_ATTEMPTS_PER_DAY) {
    throw new Error(
      `Mitra digest gave up after ${MAX_ATTEMPTS_PER_DAY} attempts today`,
    );
  }

  let status: number | undefined;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "SendMessage",
        params: {
          message: {
            messageId: crypto.randomUUID(),
            role: "ROLE_USER",
            contextId,
            parts: [{ text }],
          },
          configuration: { returnImmediately: true },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    status = response.status;

    if (response.status >= 400 && response.status < 500) {
      await markFailed(failedKey);
      throw new Error(`Mitra rejected the digest: HTTP ${status}`);
    }
    if (!response.ok) {
      throw new Error(`Mitra digest delivery failed: HTTP ${status}`);
    }

    const body = await response.json().catch(() => null);
    if (body?.error) {
      await markFailed(failedKey);
      throw new Error("Mitra rejected the digest: JSON-RPC error");
    }
  } catch (error) {
    logger.warn("Owner ping to Mitra failed", {
      contextId,
      status,
      attempt: attempts,
    });
    throw error;
  }

  await redis.set(sentKey, "1", { ex: STATE_TTL_SECONDS });
  const total = await redis.incr(pingsKey);
  if (total === 1) await redis.expire(pingsKey, STATE_TTL_SECONDS);

  logger.info("Owner ping to Mitra", {
    sentAt: new Date().toISOString(),
    contextId,
    status,
  });
}

async function markFailed(failedKey: string) {
  await redis.set(failedKey, "1", { ex: STATE_TTL_SECONDS });
}
