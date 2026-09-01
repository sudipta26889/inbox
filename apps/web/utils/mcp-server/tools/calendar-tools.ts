import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { resolveCalendarAccount } from "@/utils/calendar/resolve-account";
import { toEventTime } from "@/utils/calendar/event-time";
import type { NotifyLevel } from "@/utils/calendar/event-time";
import type { RecurrenceScope } from "@/utils/calendar/event-types";
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

/**
 * List calendars available to the account, across all connected providers.
 */
export async function listCalendars(
  context: McpToolContext,
  params: { from?: string },
) {
  logger.info("MCP tool: list_calendars", { userId: context.userId });

  const { account, providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const calendars = (
    await Promise.all(providers.map((p) => p.listCalendars()))
  ).flat();

  return { calendars, count: calendars.length, account: account.email };
}

/**
 * Update an existing calendar event, with DharaHIL approval. Attendee edits
 * are deltas (add/remove) applied via a separate changeAttendees call, never
 * folded into the patch — Google's events.patch overwrites array fields
 * wholesale, so a replacement write would silently uninvite every guest not
 * named here.
 */
export async function updateCalendarEvent(
  context: McpToolContext,
  params: {
    addAttendees?: string[];
    removeAttendees?: string[];
    description?: string;
    endTime?: string;
    eventId: string;
    from?: string;
    location?: string;
    notify?: NotifyLevel;
    scope?: RecurrenceScope;
    startTime?: string;
    timeZone?: string;
    title?: string;
  },
) {
  logger.info("MCP tool: update_calendar_event", { userId: context.userId });
  logger.trace("MCP tool: update_calendar_event details", {
    eventId: params.eventId,
    title: params.title,
    addAttendees: params.addAttendees,
    removeAttendees: params.removeAttendees,
  });

  const { account, providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  // DharaHIL approval gate for ALL calendar event updates
  if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.info("DharaHIL: Requesting approval for calendar event update", {
      eventId: params.eventId,
    });
    logger.trace("DharaHIL: calendar event update title", {
      title: params.title,
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "update_calendar_event",
      toolArgs: {
        eventId: params.eventId,
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        addAttendees: params.addAttendees || [],
        removeAttendees: params.removeAttendees || [],
        description: params.description,
        location: params.location,
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: context.userId,
        stepId: "update_event",
        contextSummary: `Update calendar event ${params.eventId}${params.title ? `: ${params.title}` : ""}`,
        riskLevel: "MEDIUM",
        tags: ["calendar", "google", "update"],
        idempotencyKey: `calendar_update_${params.eventId}_${Date.now()}`,
        metadata: {
          provider: "google",
          eventId: params.eventId,
          add_attendee_count: String(params.addAttendees?.length || 0),
          remove_attendee_count: String(params.removeAttendees?.length || 0),
        },
      },
    });

    if (dharahilClient.wasDenied(decision)) {
      const errorMsg =
        decision.action === "EXPIRED"
          ? "Calendar event update request timed out. The human approval window expired before a response was received. Please try again."
          : `Calendar event update denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`;
      throw new Error(errorMsg);
    }

    if (dharahilClient.shouldRevise(decision)) {
      throw new Error(
        `Calendar event update revision requested: ${decision.revise_input || "No specific instructions provided"}`,
      );
    }

    logger.info("DharaHIL: Calendar event update approved", {
      eventId: params.eventId,
      action: decision.action,
    });
  }

  const timeZone =
    params.startTime || params.endTime
      ? resolveTimeZone(params.timeZone, account)
      : "";

  const hasFieldChanges =
    params.title !== undefined ||
    params.description !== undefined ||
    params.location !== undefined ||
    params.startTime !== undefined ||
    params.endTime !== undefined;

  let event: { id: string; eventUrl?: string } | undefined;

  // Skip the patch entirely when only attendee deltas were requested — an
  // empty-bodied updateEvent call still triggers Google's per-request
  // sendUpdates, which would mail everyone a second time for one logical
  // change.
  if (hasFieldChanges) {
    event = await providers[0]!.updateEvent(
      params.eventId,
      {
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.description === undefined
          ? {}
          : { description: params.description }),
        ...(params.location === undefined ? {} : { location: params.location }),
        ...(params.startTime === undefined
          ? {}
          : { start: toEventTime(params.startTime, timeZone) }),
        ...(params.endTime === undefined
          ? {}
          : { end: toEventTime(params.endTime, timeZone) }),
      },
      { notify: params.notify ?? "all", scope: params.scope },
    );
  }

  // Attendee edits are a separate, read-modify-write call: folding them into
  // the patch above would discard every guest not named in this request.
  if (params.addAttendees || params.removeAttendees) {
    event = await providers[0]!.changeAttendees(
      params.eventId,
      { add: params.addAttendees, remove: params.removeAttendees },
      { notify: params.notify ?? "all" },
    );
  }

  return {
    success: true,
    eventId: event?.id ?? params.eventId,
    eventUrl: event?.eventUrl ?? "",
  };
}

/**
 * Delete a calendar event, or cancel one occurrence of a recurring event,
 * with DharaHIL approval.
 */
export async function deleteCalendarEvent(
  context: McpToolContext,
  params: {
    eventId: string;
    from?: string;
    notify?: NotifyLevel;
    scope?: RecurrenceScope;
  },
) {
  logger.info("MCP tool: delete_calendar_event", { userId: context.userId });
  logger.trace("MCP tool: delete_calendar_event details", {
    eventId: params.eventId,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  // DharaHIL approval gate for ALL calendar event deletes
  if (env.NEXT_PUBLIC_DHARAHIL_ENABLED) {
    logger.info("DharaHIL: Requesting approval for calendar event deletion", {
      eventId: params.eventId,
      scope: params.scope,
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "delete_calendar_event",
      toolArgs: {
        eventId: params.eventId,
        scope: params.scope,
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: context.userId,
        stepId: "delete_event",
        contextSummary: `Delete calendar event ${params.eventId}${params.scope === "this" ? " (one occurrence)" : ""}`,
        riskLevel: "HIGH",
        tags: ["calendar", "google", "delete"],
        idempotencyKey: `calendar_delete_${params.eventId}_${Date.now()}`,
        metadata: {
          provider: "google",
          eventId: params.eventId,
          scope: params.scope ?? "all",
        },
      },
    });

    if (dharahilClient.wasDenied(decision)) {
      const errorMsg =
        decision.action === "EXPIRED"
          ? "Calendar event deletion request timed out. The human approval window expired before a response was received. Please try again."
          : `Calendar event deletion denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`;
      throw new Error(errorMsg);
    }

    if (dharahilClient.shouldRevise(decision)) {
      throw new Error(
        `Calendar event deletion revision requested: ${decision.revise_input || "No specific instructions provided"}`,
      );
    }

    logger.info("DharaHIL: Calendar event deletion approved", {
      eventId: params.eventId,
      action: decision.action,
    });
  }

  await providers[0]!.deleteEvent(params.eventId, {
    notify: params.notify ?? "all",
    scope: params.scope,
  });

  return { success: true, eventId: params.eventId };
}

/**
 * RSVP to a calendar invitation. Not gated by DharaHIL: this only changes
 * the caller's own responseStatus row, nothing organizer-owned on the event.
 */
export async function respondToCalendarEvent(
  context: McpToolContext,
  params: {
    calendarId?: string;
    comment?: string;
    eventId: string;
    from?: string;
    responseStatus: "accepted" | "declined" | "tentative";
  },
) {
  logger.info("MCP tool: respond_to_calendar_event", {
    userId: context.userId,
  });
  logger.trace("MCP tool: respond_to_calendar_event details", {
    eventId: params.eventId,
    responseStatus: params.responseStatus,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  await providers[0]!.respondToEvent(params.eventId, {
    responseStatus: params.responseStatus,
    comment: params.comment,
    calendarId: params.calendarId,
  });

  return {
    success: true,
    eventId: params.eventId,
    responseStatus: params.responseStatus,
  };
}

/**
 * List the individual occurrences of a recurring calendar event. The
 * returned per-occurrence eventId is what update_calendar_event and
 * delete_calendar_event accept with scope: "this" to act on one occurrence
 * without touching the rest of the series.
 */
export async function listCalendarEventInstances(
  context: McpToolContext,
  params: {
    eventId: string;
    from?: string;
    maxResults?: number;
    timeMax?: string;
    timeMin?: string;
  },
) {
  logger.info("MCP tool: list_calendar_event_instances", {
    userId: context.userId,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const instances = await providers[0]!.listEventInstances(params.eventId, {
    maxResults: Math.min(params.maxResults ?? 25, 250),
    timeMin: params.timeMin,
    timeMax: params.timeMax,
  });

  return {
    instances: instances.map((instance) => ({
      eventId: instance.id,
      seriesId: instance.recurringEventId ?? params.eventId,
      originalStartTime: instance.originalStartTime,
      title: instance.title,
      start: instance.startTime.toISOString(),
      end: instance.endTime.toISOString(),
    })),
    count: instances.length,
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
