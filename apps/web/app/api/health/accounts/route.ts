import { NextResponse } from "next/server";
import { env } from "@/env";
import { secureCompare } from "@/utils/crypto-compare";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type GetAccountsHealthResponse = Awaited<
  ReturnType<typeof getAccountsHealth>
>;

// Per-mailbox connection state for GuardianAI. A mailbox whose Google/Microsoft
// grant was revoked (invalid_grant) is marked disconnected by
// cleanup-invalid-tokens, and stays so until its owner signs in again.
export const GET = withError("health/accounts", async (request) => {
  // Fails closed: unlike /api/health, this lists mailboxes.
  if (!env.HEALTH_API_KEY) {
    return NextResponse.json(
      { error: "HEALTH_API_KEY is not set" },
      { status: 503 },
    );
  }
  if (
    !secureCompare(request.headers.get("x-health-api-key"), env.HEALTH_API_KEY)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(await getAccountsHealth());
});

async function getAccountsHealth() {
  const emailAccounts = await prisma.emailAccount.findMany({
    select: {
      id: true,
      email: true,
      account: { select: { provider: true, disconnectedAt: true } },
    },
    orderBy: { email: "asc" },
  });

  const accounts = emailAccounts.map((emailAccount) => ({
    emailAccountId: emailAccount.id,
    email: emailAccount.email,
    provider: emailAccount.account?.provider ?? null,
    connected: !emailAccount.account?.disconnectedAt,
    disconnectedAt: emailAccount.account?.disconnectedAt ?? null,
  }));

  return {
    checkedAt: new Date(),
    connectedCount: accounts.filter((account) => account.connected).length,
    disconnectedCount: accounts.filter((account) => !account.connected).length,
    accounts,
  };
}
