import "server-only";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";

type EmailAccountAccess = { email: string; ownerUserId: string };

const EXPIRATION = 60 * 60; // 1 hour

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

  // Check Redis cache first
  try {
    const cachedResult = await redis.get<EmailAccountAccess | "none">(key);
    if (cachedResult === "none") return null;
    if (cachedResult && typeof cachedResult === "object") return cachedResult;
  } catch {
    // Redis unavailable — fall through to database
  }

  // Not in cache, check database
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, ...accessibleEmailAccountWhere(userId) },
    select: { email: true, userId: true },
  });

  const result = emailAccount
    ? { email: emailAccount.email, ownerUserId: emailAccount.userId }
    : null;

  // Cache the result (best-effort)
  try {
    await redis.set(key, result ?? "none", { ex: EXPIRATION });
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
  try {
    await redis.del(key);
  } catch {
    // Redis unavailable — skip invalidation
  }
}
