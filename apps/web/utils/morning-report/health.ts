import prisma from "@/utils/prisma";

export type ConnectionProblem = {
  emailAccountId: string;
  email: string;
  problem: "mailbox" | "calendar";
};

export async function findConnectionProblems({
  userId,
}: {
  userId: string;
}): Promise<ConnectionProblem[]> {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: {
      id: true,
      email: true,
      account: { select: { disconnectedAt: true, refresh_token: true } },
      calendarConnections: {
        select: { isConnected: true, refreshToken: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return emailAccounts.flatMap((emailAccount) => {
    const problems: ConnectionProblem[] = [];
    const base = { emailAccountId: emailAccount.id, email: emailAccount.email };

    // A null refresh token without disconnectedAt is the state that produced
    // a week of silent "No refresh token" failures for one mailbox.
    if (
      !emailAccount.account ||
      emailAccount.account.disconnectedAt ||
      !emailAccount.account.refresh_token
    ) {
      problems.push({ ...base, problem: "mailbox" });
    }

    // Calendar invalid_grant wipes tokens but leaves isConnected=true, and
    // event fetching then skips the connection without a word.
    if (
      emailAccount.calendarConnections.some(
        (c) => !c.isConnected || !c.refreshToken,
      )
    ) {
      problems.push({ ...base, problem: "calendar" });
    }

    return problems;
  });
}
