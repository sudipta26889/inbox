import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import prisma from "@/utils/prisma";

/**
 * A reconnect names the mailbox it is refreshing so the provider can be asked
 * for that identity and the callback can refuse a different one. Adding an
 * account has no target and stays unconstrained.
 *
 * Without this the browser's active provider session decides which mailbox gets
 * reconnected, and signing in as a second identity silently creates a new
 * account instead of refreshing the one the user was looking at.
 *
 * A shared mailbox can be reconnected by whoever it is shared with. Callers must
 * link as the returned owner `userId`: linking as the shared user would make the
 * callback treat the mailbox as another user's and start an account merge.
 */
export function findReconnectTarget({
  emailAccountId,
  userId,
  provider,
}: {
  emailAccountId: string;
  userId: string;
  provider: "google" | "microsoft";
}) {
  return prisma.emailAccount.findFirst({
    where: {
      id: emailAccountId,
      ...accessibleEmailAccountWhere(userId),
      account: { provider },
    },
    select: { id: true, email: true, userId: true },
  });
}

/**
 * The linking callback only runs for the user named in the OAuth state. A shared
 * reconnect carries the owner's id there, so the signed-in user may stand in for
 * the owner only while the target mailbox is still shared with them.
 */
export async function canLinkForUser({
  actorUserId,
  targetUserId,
  reconnectEmailAccountId,
}: {
  actorUserId: string | null;
  targetUserId: string;
  reconnectEmailAccountId: string | null | undefined;
}) {
  if (!actorUserId) return false;
  if (actorUserId === targetUserId) return true;
  if (!reconnectEmailAccountId) return false;

  const share = await prisma.emailAccountShare.findFirst({
    where: {
      userId: actorUserId,
      emailAccount: { id: reconnectEmailAccountId, userId: targetUserId },
    },
    select: { id: true },
  });
  return !!share;
}

export function isReconnectTargetMismatch({
  reconnectEmailAccountId,
  matchedEmailAccountId,
}: {
  reconnectEmailAccountId: string | null | undefined;
  matchedEmailAccountId: string | null | undefined;
}) {
  if (!reconnectEmailAccountId) return false;
  return reconnectEmailAccountId !== matchedEmailAccountId;
}
