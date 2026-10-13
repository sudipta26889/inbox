import { TZDate } from "@date-fns/tz";
import { endOfDay } from "date-fns/endOfDay";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import type { Logger } from "@/utils/logger";

const MAX_EVENTS_PER_PROVIDER = 50;
const CANCELLED_TITLE = /^\s*(?:cancelled|canceled)(?:\s+event)?\s*:/i;

export async function fetchTodayEvents({
  emailAccountId,
  timeZone,
  now,
  logger,
}: {
  emailAccountId: string;
  timeZone: string;
  now: Date;
  logger: Logger;
}): Promise<{ events: CalendarEvent[]; failed: boolean }> {
  const providers = await createCalendarEventProviders(emailAccountId, logger);
  if (!providers.length) return { events: [], failed: false };

  const timeMax = new Date(endOfDay(new TZDate(now, timeZone)).getTime());

  const results = await Promise.allSettled(
    providers.map((provider) =>
      provider.fetchEvents({
        timeMin: now,
        timeMax,
        maxResults: MAX_EVENTS_PER_PROVIDER,
      }),
    ),
  );

  const events = results
    .flatMap((result) => {
      if (result.status === "rejected") {
        logger.warn("Morning report calendar fetch failed", {
          error: result.reason,
        });
        return [];
      }
      return result.value.events;
    })
    .filter((event) => !CANCELLED_TITLE.test(event.title))
    .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return { events, failed: results.some((r) => r.status === "rejected") };
}
