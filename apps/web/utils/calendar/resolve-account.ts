import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import type { Logger } from "@/utils/logger";
import type { CalendarEventManager } from "@/utils/calendar/event-manager-types";
import { calendarConnectionProviderSelect } from "@/utils/calendar/event-provider";
import { GoogleCalendarEventManager } from "@/utils/calendar/providers/google-event-manager";
import { MicrosoftCalendarEventManager } from "@/utils/calendar/providers/microsoft-event-manager";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
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
  providers: CalendarEventManager[];
}> {
  const account = from
    ? await prisma.emailAccount.findFirst({
        where: { ...accessibleEmailAccountWhere(userId), email: from },
        select: { id: true, email: true, timezone: true },
      })
    : // Scoped by userId even on the default path: this module is the ownership
      // boundary for calendar access, so it defends itself rather than trusting
      // every caller to have composed emailAccountId safely.
      await prisma.emailAccount.findFirst({
        where: { id: emailAccountId, ...accessibleEmailAccountWhere(userId) },
        select: { id: true, email: true, timezone: true },
      });

  if (!account) {
    throw new CalendarNotConnectedError(
      from ?? "the authorized account",
      await calendarConnectedEmails(userId),
    );
  }

  const providers = await createCalendarEventManagers(account.id, logger);

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

// Write tools (create/update/delete/RSVP) always act on providers[0], so order
// deterministically: "first connection" means the oldest one.
async function createCalendarEventManagers(
  emailAccountId: string,
  logger: Logger,
): Promise<CalendarEventManager[]> {
  const connections = await prisma.calendarConnection.findMany({
    where: { emailAccountId, isConnected: true },
    orderBy: { createdAt: "asc" },
    select: calendarConnectionProviderSelect,
  });

  const managers: CalendarEventManager[] = [];
  for (const connection of connections) {
    if (!connection.refreshToken) continue;
    const params = {
      accessToken: connection.accessToken,
      refreshToken: connection.refreshToken,
      expiresAt: connection.expiresAt?.getTime() ?? null,
      emailAccountId,
    };
    if (isGoogleProvider(connection.provider)) {
      managers.push(
        new GoogleCalendarEventManager(
          { ...params, connectionId: connection.id },
          logger,
        ),
      );
    } else if (isMicrosoftProvider(connection.provider)) {
      managers.push(new MicrosoftCalendarEventManager(params, logger));
    }
  }
  return managers;
}
