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
      ex: PROCESSING_TTL_SECONDS,
      nx: true, // Only set if key doesn't exist
    },
  );

  // Redis returns "OK" if the key was set, and null if it was already set
  return result === "OK";
}

const PROCESSING_TTL_SECONDS = 60 * 5;
const DONE_VALUE = "done";

// Keeps the lock after success, marked done, to dedupe repeat webhooks. A held
// lock that is not done is still in flight (or its run was killed), so the
// webhook must not move the history pointer past it. On failure the lock is
// released so a retry inside the TTL (rate-limit catch-up) runs.
export async function withMessageProcessingLock(
  { userEmail, messageId }: { userEmail: string; messageId: string },
  fn: () => Promise<unknown>,
): Promise<{ skipped: boolean; inFlight: boolean }> {
  const key = getProcessingKey({ userEmail, messageId });
  const isFree = await markMessageAsProcessing({ userEmail, messageId });
  if (!isFree) {
    const value = await redis.get(key);
    return { skipped: true, inFlight: value !== DONE_VALUE };
  }

  try {
    await fn();
  } catch (error) {
    // ponytail: plain del, not an owned-lock compare-and-delete. A run that
    // outlives the TTL can clear a later holder's lock, letting a third run
    // start alongside it; the ExecutedRule check still stops a second rule run.
    await redis.del(key).catch(() => {});
    throw error;
  }

  // Overwriting a later holder's in-flight value after a TTL expiry is safe:
  // this run did process the message, so "done" is true either way.
  await redis.set(key, DONE_VALUE, { ex: PROCESSING_TTL_SECONDS });
  return { skipped: false, inFlight: false };
}

export class MessageInFlightError extends Error {
  constructor() {
    super("Message is still being processed by another run");
    this.name = "MessageInFlightError";
  }
}
