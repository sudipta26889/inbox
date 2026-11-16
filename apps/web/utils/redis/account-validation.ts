import "server-only";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("account-validation");

type EmailAccountAccess = { email: string; ownerUserId: string };

// Short so a revoked share also lapses on its own if an invalidation is lost.
const EXPIRATION = 5 * 60;

/**
 * Get the Redis key for account validation
 */
function getValidationKey({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): string {
  return `account-access:${userId}:${emailAccountId}`;
}

/**
 * Validate that a user owns, or has been shared, an email account, using Redis for caching.
 * Returns the account email and its owner's user id (callers act as the owner on shared accounts).
 */
export async function getEmailAccount({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<EmailAccountAccess | null> {
  if (!userId || !emailAccountId) return null;

  const key = getValidationKey({ userId, emailAccountId });

  // Check Redis cache first. Only grants are cached: a refusal is re-checked
  // every time, so a new share or ownership change applies at once.
  try {
    const cachedResult = await redis.get<EmailAccountAccess>(key);
    if (cachedResult && typeof cachedResult === "object") return cachedResult;
  } catch {
    // Redis unavailable — fall through to database
  }

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, ...accessibleEmailAccountWhere(userId) },
    select: { email: true, userId: true },
  });
  if (!emailAccount) return null;

  const result = {
    email: emailAccount.email,
    ownerUserId: emailAccount.userId,
  };

  // Cache the result (best-effort)
  try {
    await redis.set(key, result, { ex: EXPIRATION });
  } catch {
    // Redis unavailable — skip caching
  }

  return result;
}

/**
 * Invalidate the cached validation result for a user's account
 * Useful when account ownership or sharing changes
 */
export async function invalidateAccountValidation({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<void> {
  const key = getValidationKey({ userId, emailAccountId });
  // A lost delete keeps revoked access alive until the TTL, so retry once and
  // make a second failure visible.
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await redis.del(key);
      return;
    } catch (error) {
      if (attempt === 2) {
        logger.error("Failed to invalidate account access cache", {
          userId,
          emailAccountId,
          error,
        });
      }
    }
  }
}
