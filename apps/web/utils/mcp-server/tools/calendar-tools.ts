import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { resolveCalendarAccount } from "@/utils/calendar/resolve-account";
import { toEventTime } from "@/utils/calendar/event-time";
import type { NotifyLevel } from "@/utils/calendar/event-time";
import { dharahilClient } from "@/utils/dharahil/client";
import { env } from "@/env";
import { extractEventId } from "./url-parser";

const logger = createScopedLogger("mcp-calendar-tools");

/**
 * Search calendar events in a date range
 */
export async function searchCalendar(
  context: McpToolContext,
  params: {
    startDate: string;
    endDate: string;
    query?: string;
    maxResults?: number;
    pageToken?: string;
    from?: string;
  },
) {
  logger.info("MCP tool: search_calendar", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const results = await Promise.all(
    providers.map((provider) =>
      provider.fetchEvents({
        timeMin: new Date(params.startDate),
        timeMax: new Date(params.endDate),
        query: params.query,
        maxResults: params.maxResults,
        pageToken: params.pageToken,
      }),
    ),
  );

  const events = results.flatMap(
    ({ events: providerEvents = [] }) => providerEvents,
  );
  const nextPageToken = results[0]?.nextPageToken ?? null;

  return {
    events: events.map((event) => ({
      id: event.id,
      summary: event.title,
      description: event.description || "",
      start: event.startTime.toISOString(),
      end: event.endTime.toISOString(),
      location: event.location || "",
      attendees:
        event.attendees?.map((a) => ({
          email: a.email,
          name: a.name || "",
        })) || [],
      htmlLink: event.eventUrl || "",
    })),
    count: events.length,
    nextPageToken,
  };
}

/**
 * Get a specific calendar event by ID or URL
 */
export async function getCalendarEvent(
  context: McpToolContext,
  params: { eventId: string; from?: string },
) {
  // Extract event ID from Calendar URL if provided
  const eventId = extractEventId(params.eventId);

  logger.info("MCP tool: get_calendar_event", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    eventId,
    originalInput: params.eventId !== eventId ? params.eventId : undefined,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  // Try to fetch the event from each provider
  for (const provider of providers) {
    try {
      const event = await provider.fetchEventById(eventId);
      if (event) {
        logger.trace("Event found successfully", {
          eventId,
          title: event.title,
        });
        return {
          id: event.id,
          summary: event.title,
          description: event.description || "",
          start: event.startTime.toISOString(),
          end: event.endTime.toISOString(),
          location: event.location || "",
          attendees:
            event.attendees?.map((a) => ({
              email: a.email,
              name: a.name || "",
              responseStatus: a.responseStatus || "",
            })) || [],
          htmlLink: event.eventUrl || "",
        };
      }
    } catch (error) {
      logger.error("Event not found in provider", {
        eventId,
        providerType: provider.constructor.name,
        error:
          error instanceof Error
            ? { message: error.message, stack: error.stack }
            : error,
      });
    }
  }

  logger.error("Event not found in any provider", {
    eventId,
    originalInput: params.eventId,
    providersChecked: providers.length,
  });

  throw new Error(`Calendar event "${eventId}" not found`);
}

/**
 * Get calendar availability (free/busy)
 */
export async function getCalendarAvailability(
  context: McpToolContext,
  params: { startDate: string; endDate: string; from?: string },
) {
  logger.info("MCP tool: get_calendar_availability", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    startDate: params.startDate,
    endDate: params.endDate,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const results = await Promise.all(
    providers.map((provider) =>
      provider.fetchEvents({
        timeMin: new Date(params.startDate),
        timeMax: new Date(params.endDate),
        maxResults: 100,
      }),
    ),
  );

  const events = results.flatMap(
    ({ events: providerEvents = [] }) => providerEvents,
  );

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
      return (
        total + (period.end.getTime() - period.start.getTime()) / (1000 * 60)
      );
    }, 0),
  };
}

/**
 * Create a new calendar event with DharaHIL approval
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
    timeZone?: string;
    notify?: NotifyLevel;
    idempotencyKey?: string;
    recurrence?: string[];
    from?: string;
  },
) {
  logger.info("MCP tool: create_calendar_event", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    startTime: params.startTime,
    endTime: params.endTime,
  });
  logger.trace("MCP tool: create_calendar_event details", {
    title: params.title,
    attendees: params.attendees,
  });

  const { account, providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const hasExternalAttendees = params.attendees?.some((email) =>
    isExternalDomain(email),
  );
  const sendInvite = params.sendInvite ?? true;

  // Determine if this should be tagged as external
  // Treat events with no attendees as "external" to avoid DharaHIL auto-rejection
  // This matches send_email behavior where all requests go through approval
  const isExternal =
    !params.attendees || params.attendees.length === 0 || hasExternalAttendees;

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
        riskLevel: isExternal ? "HIGH" : "MEDIUM",
        tags: ["calendar", "google", isExternal ? "external" : "internal"],
        idempotencyKey: `calendar_${params.title}_${params.startTime}_${Date.now()}`,
        metadata: {
          provider: "google",
          title: params.title,
          attendee_count: String(params.attendees?.length || 0),
          has_external_attendees: isExternal ? "true" : "false",
          send_invite: sendInvite ? "true" : "false",
        },
      },
    });

    if (dharahilClient.wasDenied(decision)) {
      const errorMsg =
        decision.action === "EXPIRED"
          ? "Calendar event creation request timed out. The human approval window expired before a response was received. Please try again."
          : `Calendar event creation denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`;
      throw new Error(errorMsg);
    }

    if (dharahilClient.shouldRevise(decision)) {
      throw new Error(
        `Calendar event revision requested: ${decision.revise_input || "No specific instructions provided"}`,
      );
    }

    logger.info("DharaHIL: Calendar event creation approved", {
      title: params.title,
      action: decision.action,
    });
  }

  const timeZone = resolveTimeZone(params.timeZone, account);

  // `notify` is the richer control; `sendInvite` is the tool's original
  // boolean and must keep working — ignoring it mails attendees against an
  // explicit instruction.
  const notify: NotifyLevel =
    params.notify ?? (params.sendInvite === false ? "none" : "all");

  const event = await providers[0]!.createEvent(
    {
      title: params.title,
      description: params.description,
      location: params.location,
      start: toEventTime(params.startTime, timeZone),
      end: toEventTime(params.endTime, timeZone),
      attendees: params.attendees,
      recurrence: params.recurrence,
    },
    {
      notify,
      idempotencyKey: params.idempotencyKey,
    },
  );

  logger.info("Calendar event created successfully", { eventId: event.id });
  logger.trace("Calendar event created", { title: params.title });

  return {
    success: true,
    eventId: event.id,
    eventUrl: event.eventUrl || "",
    summary: event.title,
    start: event.startTime.toISOString(),
    end: event.endTime.toISOString(),
    attendees: event.attendees.map((a) => ({
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

function resolveTimeZone(
  explicit: string | undefined,
  account: { timezone: string | null },
): string {
  const zone = explicit ?? account.timezone ?? "";
  if (!zone) {
    throw new Error(
      "Timezone could not be resolved. Pass timeZone as an IANA name (e.g. 'Asia/Kolkata'), or set a timezone on the account.",
    );
  }
  return zone;
}
