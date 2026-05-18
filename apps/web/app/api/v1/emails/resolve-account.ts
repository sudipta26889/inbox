import prisma from "@/utils/prisma";

export async function resolveUserAccount({
  userId,
  requestedAccountId,
}: {
  userId: string;
  requestedAccountId: string;
}): Promise<{ emailAccountId: string; provider: string } | null> {
  const emailAccount = await prisma.emailAccount.findFirst({
    where: { id: requestedAccountId, userId },
    select: {
      id: true,
      account: { select: { provider: true } },
    },
  });

  if (!emailAccount?.account) return null;

  return {
    emailAccountId: emailAccount.id,
    provider: emailAccount.account.provider,
  };
}
