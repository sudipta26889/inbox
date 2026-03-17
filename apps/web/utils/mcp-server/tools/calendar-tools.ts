import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";

const logger = createScopedLogger("mcp-calendar-tools");

/**
 * Search calendar events in a date range
 */
export async function searchCalendar(
  context: McpToolContext,
  params: { startDate: string; endDate: string; query?: string }
) {
  logger.info("MCP tool: search_calendar", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const providers = await createCalendarEventProviders(context.emailAccountId, logger);

  if (providers.length === 0) {
    throw new Error("No calendar connection found for this email account");
  }

  // Fetch events from all providers
  const allEvents = await Promise.all(
    providers.map((provider) =>
      provider.fetchEvents({
        timeMin: new Date(params.startDate),
        timeMax: new Date(params.endDate),
        maxResults: 50,
      })
    )
  );

  // Flatten and deduplicate events
  const events = allEvents.flat();

  // Filter by query if provided
  let filteredEvents = events;
  if (params.query) {
    const queryLower = params.query.toLowerCase();
    filteredEvents = events.filter(
      (event) =>
        event.title?.toLowerCase().includes(queryLower) ||
        event.description?.toLowerCase().includes(queryLower) ||
        event.location?.toLowerCase().includes(queryLower)
    );
  }

  return {
    events: filteredEvents.map((event) => ({
      id: event.id,
      summary: event.title,
      description: event.description || "",
      start: event.startTime.toISOString(),
      end: event.endTime.toISOString(),
      location: event.location || "",
      attendees: event.attendees?.map((a) => ({
        email: a.email,
        name: a.name || "",
      })) || [],
      htmlLink: event.eventUrl || "",
    })),
    count: filteredEvents.length,
  };
}

/**
 * Get calendar availability (free/busy)
 */
export async function getCalendarAvailability(
  context: McpToolContext,
  params: { startDate: string; endDate: string }
) {
  logger.info("MCP tool: get_calendar_availability", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const providers = await createCalendarEventProviders(context.emailAccountId, logger);

  if (providers.length === 0) {
    throw new Error("No calendar connection found for this email account");
  }

  // Fetch events from all providers
  const allEvents = await Promise.all(
    providers.map((provider) =>
      provider.fetchEvents({
        timeMin: new Date(params.startDate),
        timeMax: new Date(params.endDate),
        maxResults: 100,
      })
    )
  );

  // Flatten events
  const events = allEvents.flat();

  // Calculate busy periods (all events block time by default)
  const busyPeriods = events
    .map((event) => ({
      start: event.startTime,
      end: event.endTime,
      summary: event.title || "Busy",
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  // Calculate free periods
  const freePeriods = [];
  const startTime = new Date(params.startDate);
  const endTime = new Date(params.endDate);

  let currentTime = startTime;

  for (const busyPeriod of busyPeriods) {
    const busyStart = busyPeriod.start;

    if (currentTime < busyStart) {
      freePeriods.push({
        start: currentTime.toISOString(),
        end: busyStart.toISOString(),
      });
    }

    const busyEnd = busyPeriod.end;
    currentTime = busyEnd > currentTime ? busyEnd : currentTime;
  }

  // Add final free period if any
  if (currentTime < endTime) {
    freePeriods.push({
      start: currentTime.toISOString(),
      end: endTime.toISOString(),
    });
  }

  return {
    timeRange: {
      start: params.startDate,
      end: params.endDate,
    },
    busy: busyPeriods.map((period) => ({
      start: period.start.toISOString(),
      end: period.end.toISOString(),
      summary: period.summary,
    })),
    free: freePeriods,
    totalBusyMinutes: busyPeriods.reduce((total, period) => {
      return total + (period.end.getTime() - period.start.getTime()) / (1000 * 60);
    }, 0),
  };
}
