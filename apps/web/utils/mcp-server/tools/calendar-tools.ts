import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import { dharahilClient } from "@/utils/dharahil/client";
import { env } from "@/env";

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

/**
 * Create a new calendar event with DharaHIL approval
 * Always uses sudiptai26.889@gmail.com for calendar operations
 */
export async function createCalendarEvent(
  context: McpToolContext,
  params: {
    title: string;
    startTime: string;
    endTime: string;
    attendees?: string[];
    description?: string;
    location?: string;
    sendInvite?: boolean;
  }
) {
  logger.info("MCP tool: create_calendar_event", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    title: params.title,
    startTime: params.startTime,
    endTime: params.endTime,
    attendees: params.attendees,
  });

  // Always use sudiptai26.889@gmail.com for calendar operations
  const CALENDAR_EMAIL = "sudiptai26.889@gmail.com";
  const calendarEmailAccount = await prisma.emailAccount.findFirst({
    where: {
      userId: context.userId,
      email: CALENDAR_EMAIL,
    },
    include: { account: true },
  });

  if (!calendarEmailAccount) {
    throw new Error(
      `Calendar account (${CALENDAR_EMAIL}) not found. Please connect this Google account with calendar permissions.`
    );
  }

  logger.info("Using calendar account", {
    email: calendarEmailAccount.email,
    hasRefreshToken: !!calendarEmailAccount.account?.refresh_token,
  });

  const hasExternalAttendees = params.attendees?.some((email) =>
    isExternalDomain(email)
  );
  const sendInvite = params.sendInvite ?? true;

  // DharaHIL approval gate for ALL calendar event creates
  if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.info("DharaHIL: Requesting approval for calendar event creation", {
      title: params.title,
      attendees: params.attendees,
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "create_calendar_event",
      toolArgs: {
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        attendees: params.attendees || [],
        description: params.description,
        location: params.location,
        sendInvite,
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: context.userId,
        stepId: "create_event",
        contextSummary: `Create calendar event: ${params.title} with ${params.attendees?.length || 0} attendees`,
        riskLevel: hasExternalAttendees ? "HIGH" : "MEDIUM",
        tags: [
          "calendar",
          "google",
          hasExternalAttendees ? "external" : "internal",
        ],
        idempotencyKey: `calendar_${params.title}_${params.startTime}_${Date.now()}`,
        metadata: {
          provider: "google",
          title: params.title,
          attendee_count: String(params.attendees?.length || 0),
          has_external_attendees: hasExternalAttendees ? "true" : "false",
          send_invite: sendInvite ? "true" : "false",
        },
      },
    });

    if (dharahilClient.wasDenied(decision)) {
      throw new Error(
        `Calendar event creation denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`
      );
    }

    if (dharahilClient.shouldRevise(decision)) {
      throw new Error(
        `Calendar event revision requested: ${decision.revise_input || "No specific instructions provided"}`
      );
    }

    logger.info("DharaHIL: Calendar event creation approved", {
      title: params.title,
      action: decision.action,
    });
  }

  // Get Google Calendar client
  const calendar = await getCalendarClientWithRefresh({
    accessToken: calendarEmailAccount.account?.access_token || null,
    refreshToken: calendarEmailAccount.account?.refresh_token || null,
    expiresAt: calendarEmailAccount.account?.expires_at
      ? new Date(calendarEmailAccount.account.expires_at).getTime()
      : null,
    emailAccountId: calendarEmailAccount.id,
    logger,
  });

  // Create the event
  const eventResource = {
    summary: params.title,
    description: params.description,
    location: params.location,
    start: {
      dateTime: params.startTime,
      timeZone: "UTC",
    },
    end: {
      dateTime: params.endTime,
      timeZone: "UTC",
    },
    attendees: params.attendees?.map((email) => ({ email })),
  };

  const result = await calendar.events.insert({
    calendarId: "primary",
    sendNotifications: sendInvite,
    requestBody: eventResource,
  });

  logger.info("Calendar event created successfully", {
    eventId: result.data.id,
    title: params.title,
  });

  return {
    success: true,
    eventId: result.data.id || "",
    eventUrl: result.data.htmlLink || "",
    summary: result.data.summary || "",
    start: result.data.start?.dateTime || "",
    end: result.data.end?.dateTime || "",
    attendees: result.data.attendees?.map((a) => ({
      email: a.email,
      responseStatus: a.responseStatus,
    })),
  };
}

// Helper to determine if email domain is external
function isExternalDomain(email: string): boolean {
  const internalDomains = ["sudiptadhara.in", "localhost"];
  const domain = email.split("@")[1]?.toLowerCase();
  return !internalDomains.some((internal) => domain?.includes(internal));
}
