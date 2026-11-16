"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import {
  reorderEmailAccountsBody,
  updateAllAccountsSelectionBody,
} from "@/utils/actions/all-accounts.validation";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";

export const updateAllAccountsSelectionAction = actionClientUser
  .metadata({ name: "updateAllAccountsSelection" })
  .inputSchema(updateAllAccountsSelectionBody)
  .action(async ({ ctx: { userId }, parsedInput: { emailAccountIds } }) => {
    const emailAccounts = await prisma.emailAccount.findMany({
      where: accessibleEmailAccountWhere(userId),
      select: { id: true },
    });
    const ownedAccountIds = new Set(
      emailAccounts.map((emailAccount) => emailAccount.id),
    );

    if (emailAccountIds.some((id) => !ownedAccountIds.has(id))) {
      throw new SafeError("Email account not found");
    }

    // ponytail: includeInAllAccounts and sortOrder live on the account, so a
    // shared user's choice applies to the owner too (shared users act as owner).
    const accessible = accessibleEmailAccountWhere(userId);
    await prisma.$transaction([
      prisma.emailAccount.updateMany({
        where: { ...accessible, id: { in: emailAccountIds } },
        data: { includeInAllAccounts: true },
      }),
      prisma.emailAccount.updateMany({
        where: { ...accessible, id: { notIn: emailAccountIds } },
        data: { includeInAllAccounts: false },
      }),
    ]);
  });

/** Saves the account switcher order, which Control/⌘+1–9 also follow. */
export const reorderEmailAccountsAction = actionClientUser
  .metadata({ name: "reorderEmailAccounts" })
  .inputSchema(reorderEmailAccountsBody)
  .action(async ({ ctx: { userId }, parsedInput: { emailAccountIds } }) => {
    const emailAccounts = await prisma.emailAccount.findMany({
      where: accessibleEmailAccountWhere(userId),
      select: { id: true },
    });
    const ownedAccountIds = new Set(
      emailAccounts.map((emailAccount) => emailAccount.id),
    );

    // A partial list would leave positions colliding with the ones it skipped.
    if (
      emailAccountIds.length !== ownedAccountIds.size ||
      emailAccountIds.some((id) => !ownedAccountIds.has(id))
    ) {
      throw new SafeError(
        "Your accounts changed. Refresh the page and try again.",
      );
    }

    const accessible = accessibleEmailAccountWhere(userId);
    await prisma.$transaction(
      emailAccountIds.map((id, sortOrder) =>
        prisma.emailAccount.updateMany({
          where: { id, ...accessible },
          data: { sortOrder },
        }),
      ),
    );
  });
