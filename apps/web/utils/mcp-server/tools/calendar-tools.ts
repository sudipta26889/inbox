import prisma from "@/utils/prisma";
import { getCalendarClient } from "@/utils/calendar/client";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";

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

  const calendarClient = await getCalendarClient(context.emailAccountId);

  if (!calendarClient) {
    throw new Error("No calendar connection found for this email account");
  }

  const events = await calendarClient.listEvents({
    timeMin: new Date(params.startDate),
    timeMax: new Date(params.endDate),
    maxResults: 50,
  });

  // Filter by query if provided
  let filteredEvents = events;
  if (params.query) {
    const queryLower = params.query.toLowerCase();
    filteredEvents = events.filter(
      (event) =>
        event.summary?.toLowerCase().includes(queryLower) ||
        event.description?.toLowerCase().includes(queryLower) ||
        event.location?.toLowerCase().includes(queryLower)
    );
  }

  return {
    events: filteredEvents.map((event) => ({
      id: event.id,
      summary: event.summary || "Untitled Event",
      description: event.description || "",
      start: event.start,
      end: event.end,
      location: event.location || "",
      attendees: event.attendees?.map((a) => ({
        email: a.email,
        name: a.name,
        responseStatus: a.responseStatus,
      })) || [],
      organizer: event.organizer ? {
        email: event.organizer.email,
        name: event.organizer.name,
      } : null,
      status: event.status,
      htmlLink: event.htmlLink,
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

  const calendarClient = await getCalendarClient(context.emailAccountId);

  if (!calendarClient) {
    throw new Error("No calendar connection found for this email account");
  }

  // Get all events in the time range
  const events = await calendarClient.listEvents({
    timeMin: new Date(params.startDate),
    timeMax: new Date(params.endDate),
    maxResults: 100,
  });

  // Calculate busy periods
  const busyPeriods = events
    .filter((event) => {
      // Only include events that actually block time
      return (
        event.status !== "cancelled" &&
        event.transparency !== "transparent" // transparent = doesn't block time
      );
    })
    .map((event) => ({
      start: event.start,
      end: event.end,
      summary: event.summary || "Busy",
    }))
    .sort((a, b) => {
      const aStart = typeof a.start === "string" ? new Date(a.start) : a.start.dateTime ? new Date(a.start.dateTime) : new Date(a.start.date!);
      const bStart = typeof b.start === "string" ? new Date(b.start) : b.start.dateTime ? new Date(b.start.dateTime) : new Date(b.start.date!);
      return aStart.getTime() - bStart.getTime();
    });

  // Calculate free periods
  const freePeriods = [];
  const startTime = new Date(params.startDate);
  const endTime = new Date(params.endDate);

  let currentTime = startTime;

  for (const busyPeriod of busyPeriods) {
    const busyStart = typeof busyPeriod.start === "string"
      ? new Date(busyPeriod.start)
      : busyPeriod.start.dateTime
        ? new Date(busyPeriod.start.dateTime)
        : new Date(busyPeriod.start.date!);

    if (currentTime < busyStart) {
      freePeriods.push({
        start: currentTime.toISOString(),
        end: busyStart.toISOString(),
      });
    }

    const busyEnd = typeof busyPeriod.end === "string"
      ? new Date(busyPeriod.end)
      : busyPeriod.end.dateTime
        ? new Date(busyPeriod.end.dateTime)
        : new Date(busyPeriod.end.date!);

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
      start: typeof period.start === "string"
        ? period.start
        : period.start.dateTime || period.start.date,
      end: typeof period.end === "string"
        ? period.end
        : period.end.dateTime || period.end.date,
      summary: period.summary,
    })),
    free: freePeriods,
    totalBusyMinutes: busyPeriods.reduce((total, period) => {
      const start = typeof period.start === "string"
        ? new Date(period.start)
        : period.start.dateTime
          ? new Date(period.start.dateTime)
          : new Date(period.start.date!);
      const end = typeof period.end === "string"
        ? new Date(period.end)
        : period.end.dateTime
          ? new Date(period.end.dateTime)
          : new Date(period.end.date!);
      return total + (end.getTime() - start.getTime()) / (1000 * 60);
    }, 0),
  };
}
