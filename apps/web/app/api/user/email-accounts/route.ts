import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  ownedLastEmailAccountId,
  parseLastEmailAccountCookieValue,
} from "@/utils/cookies";
import { withAuth } from "@/utils/middleware";
import { EMAIL_ACCOUNT_ORDER_BY } from "@/utils/email-account-order";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";

export type GetEmailAccountsResponse = Awaited<
  ReturnType<typeof getEmailAccounts>
>;

async function getEmailAccounts({ userId }: { userId: string }) {
  const cookieStore = await cookies();
  const lastEmailAccountCookieId = parseLastEmailAccountCookieValue({
    userId,
    cookieValue: cookieStore.get(LAST_EMAIL_ACCOUNT_COOKIE)?.value,
  });

  const emailAccounts = await prisma.emailAccount.findMany({
    where: accessibleEmailAccountWhere(userId),
    select: {
      id: true,
      userId: true,
      email: true,
      accountId: true,
      name: true,
      image: true,
      includeInAllAccounts: true,
      account: {
        select: {
          disconnectedAt: true,
          provider: true,
        },
      },
      user: {
        select: {
          name: true,
          image: true,
          email: true,
        },
      },
      shares: {
        select: { user: { select: { id: true, email: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
    orderBy: EMAIL_ACCOUNT_ORDER_BY,
  });

  const accountsWithRateLimits = await Promise.all(
    emailAccounts.map(async (account) => {
      const providerRateLimit = await getEmailProviderRateLimitState({
        emailAccountId: account.id,
      });

      return {
        ...account,
        account: {
          ...account.account,
          disconnectedAt: account.account.disconnectedAt?.toISOString() ?? null,
        },
        providerRateLimit: providerRateLimit
          ? {
              provider: providerRateLimit.provider,
              retryAt: providerRateLimit.retryAt.toISOString(),
              source: providerRateLimit.source,
            }
          : null,
      };
    }),
  );

  const accountsWithNames = accountsWithRateLimits.map(
    ({ userId: ownerUserId, shares, ...account }) => {
      const isShared = ownerUserId !== userId;
      // Only the owner may see or manage who else has access.
      const sharedWith = isShared ? [] : shares.map((share) => share.user);

      // Old accounts don't have a name attached, so use the name from the user
      if (account.user.email === account.email) {
        return {
          ...account,
          name: account.name || account.user.name,
          image: account.image || account.user.image,
          isPrimary: !isShared,
          isShared,
          sharedWith,
        };
      }

      return { ...account, isPrimary: false, isShared, sharedWith };
    },
  );

  return {
    emailAccounts: accountsWithNames,
    lastEmailAccountId: ownedLastEmailAccountId(
      lastEmailAccountCookieId,
      emailAccounts.map((account) => account.id),
    ),
  };
}

export const GET = withAuth("user/email-accounts", async (request) => {
  const userId = request.auth.userId;
  const result = await getEmailAccounts({ userId });
  return NextResponse.json(result);
});
