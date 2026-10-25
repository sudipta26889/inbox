import "server-only";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";

const EXPIRATION = 60 * 60; // 1 hour

type EmailAccountAccess = { email: string; ownerUserId: string };

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

  const cachedResult = await redis.get<EmailAccountAccess | "none">(key);
  if (cachedResult === "none") return null;
  if (cachedResult) return cachedResult;

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, ...accessibleEmailAccountWhere(userId) },
    select: { email: true, userId: true },
  });

  const result = emailAccount
    ? { email: emailAccount.email, ownerUserId: emailAccount.userId }
    : null;

  await redis.set(key, result ?? "none", { ex: EXPIRATION });

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
  await redis.del(key);
}
