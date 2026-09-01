import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import type { CalendarEventProvider } from "@/utils/calendar/event-types";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import { CalendarNotConnectedError } from "@/utils/calendar/errors";

/**
 * Resolve which of the caller's accounts to act on, and its calendar
 * providers. Replaces the previously hardcoded calendar address, which made
 * every calendar tool unusable for anyone but one specific user.
 */
export async function resolveCalendarAccount({
  userId,
  emailAccountId,
  from,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  from?: string;
  logger: Logger;
}): Promise<{
  account: { id: string; email: string; timezone: string | null };
  providers: CalendarEventProvider[];
}> {
  const account = from
    ? await prisma.emailAccount.findFirst({
        where: { userId, email: from },
        select: { id: true, email: true, timezone: true },
      })
    : await prisma.emailAccount.findUnique({
        where: { id: emailAccountId },
        select: { id: true, email: true, timezone: true },
      });

  if (!account) {
    throw new CalendarNotConnectedError(
      from ?? emailAccountId,
      await calendarConnectedEmails(userId),
    );
  }

  const providers = await createCalendarEventProviders(account.id, logger);

  if (providers.length === 0) {
    throw new CalendarNotConnectedError(
      account.email,
      await calendarConnectedEmails(userId),
    );
  }

  return { account, providers };
}

async function calendarConnectedEmails(userId: string): Promise<string[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId, calendarConnections: { some: { isConnected: true } } },
    select: { email: true },
  });
  return accounts.map((a) => a.email);
}
