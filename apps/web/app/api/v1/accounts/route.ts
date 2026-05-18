import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withAccountApiKey } from "@/utils/api-middleware";

export const GET = withAccountApiKey("v1/accounts", [], async (request) => {
  const { userId, emailAccountId: keyEmailAccountId } = request.apiAuth;

  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: {
      id: true,
      email: true,
      account: { select: { provider: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({
    accounts: emailAccounts.map((a) => ({
      id: a.id,
      email: a.email,
      provider: a.account?.provider ?? "unknown",
      is_default: a.id === keyEmailAccountId,
    })),
  });
});
