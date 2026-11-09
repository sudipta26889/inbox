import { redis } from "@/utils/redis";

function getProcessingKey({
  userEmail,
  messageId,
}: {
  userEmail: string;
  messageId: string;
}) {
  return `processing-message:${userEmail}:${messageId}`;
}

export async function markMessageAsProcessing({
  userEmail,
  messageId,
}: {
  userEmail: string;
  messageId: string;
}): Promise<boolean> {
  const result = await redis.set(
    getProcessingKey({ userEmail, messageId }),
    "true",
    {
      ex: 60 * 5, // 5 minutes
      nx: true, // Only set if key doesn't exist
    },
  );

  // Redis returns "OK" if the key was set, and null if it was already set
  return result === "OK";
}

// Keeps the lock after success to dedupe repeat webhooks, but releases it on
// failure so a retry inside the TTL (rate-limit catch-up) is not skipped.
export async function withMessageProcessingLock(
  { userEmail, messageId }: { userEmail: string; messageId: string },
  fn: () => Promise<unknown>,
): Promise<{ skipped: boolean }> {
  const isFree = await markMessageAsProcessing({ userEmail, messageId });
  if (!isFree) return { skipped: true };

  try {
    await fn();
    return { skipped: false };
  } catch (error) {
    // ponytail: plain del, not an owned-lock compare-and-delete; a run that
    // outlives the 5-minute TTL could clear a later holder's lock.
    await redis.del(getProcessingKey({ userEmail, messageId })).catch(() => {});
    throw error;
  }
}
