import { createScopedLogger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import {
  acquireOwnedLock,
  clearOwnedLock,
  markOwnedLockProcessed,
} from "@/utils/redis/owned-lock";

const OUTBOUND_PROCESSING_TTL_SECONDS = 60 * 30;
const OUTBOUND_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 30;
const OUTBOUND_PROCESSED_STATUS = "processed";

const PROCESSING_TTL_SECONDS = 60 * 5;
const PROCESSING_DONE_STATUS = "done";

// After success the lock is kept, marked done, to dedupe repeat webhooks. A held
// lock that is not done is still in flight (or its run was killed), so the
// Gmail webhook must not move its history pointer past that message.
export async function withMessageProcessingLock(
  { userEmail, messageId }: { userEmail: string; messageId: string },
  fn: () => Promise<unknown>,
): Promise<{ skipped: boolean; inFlight: boolean }> {
  const key = `processing-message:${userEmail}:${messageId}`;
  const lockToken = await acquireOwnedLock({
    key,
    processingTtlSeconds: PROCESSING_TTL_SECONDS,
  });
  if (!lockToken) {
    const value = await redis.get<string>(key);
    return { skipped: true, inFlight: value !== PROCESSING_DONE_STATUS };
  }

  try {
    await fn();
  } catch (error) {
    try {
      await clearOwnedLock({ key, lockToken });
    } catch (clearError) {
      createScopedLogger("message-processing").warn(
        "Failed to clear message processing lock",
        { error: clearError },
      );
    }
    throw error;
  }

  // Compare-and-set: a run that outlived the TTL leaves a later holder's lock alone.
  await markOwnedLockProcessed({
    key,
    lockToken,
    processedStatus: PROCESSING_DONE_STATUS,
    processedTtlSeconds: PROCESSING_TTL_SECONDS,
  });
  return { skipped: false, inFlight: false };
}

export class MessageInFlightError extends Error {
  constructor() {
    super("Message is still being processed by another run");
    this.name = "MessageInFlightError";
  }
}

type OutboundMessageKey = {
  emailAccountId: string;
  messageId: string;
  lockToken?: string;
};

export async function acquireOutboundMessageLock({
  emailAccountId,
  messageId,
}: OutboundMessageKey): Promise<string | null> {
  return acquireOwnedLock({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    processingTtlSeconds: OUTBOUND_PROCESSING_TTL_SECONDS,
  });
}

export async function markOutboundMessageProcessed({
  emailAccountId,
  messageId,
  lockToken,
}: OutboundMessageKey): Promise<boolean> {
  return markOwnedLockProcessed({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    lockToken,
    processedStatus: OUTBOUND_PROCESSED_STATUS,
    processedTtlSeconds: OUTBOUND_PROCESSED_TTL_SECONDS,
  });
}

export async function clearOutboundMessageLock({
  emailAccountId,
  messageId,
  lockToken,
}: OutboundMessageKey): Promise<boolean> {
  return clearOwnedLock({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    lockToken,
  });
}

function getOutboundMessageKey({
  emailAccountId,
  messageId,
}: OutboundMessageKey) {
  return `reply-tracker:outbound-message:${emailAccountId}:${messageId}`;
}
