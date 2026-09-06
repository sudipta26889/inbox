import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { resolveCalendarAccount } from "@/utils/calendar/resolve-account";
import { toEventTime, allDayEndDate } from "@/utils/calendar/event-time";
import type { EventTime, NotifyLevel } from "@/utils/calendar/event-time";
import type {
  CalendarEvent,
  CalendarEventProvider,
  RecurrenceScope,
} from "@/utils/calendar/event-types";
import { dharahilClient } from "@/utils/dharahil/client";
import { isApprovalGateRequired } from "@/utils/dharahil/required";
import { extractEventId } from "./url-parser";

const logger = createScopedLogger("mcp-calendar-tools");

// Safety cap on availability paging: results come back ordered by start
// time, so an unbounded loop against a provider bug (a token that never
// clears) could hang forever. 10 pages * 250/page = 2500, matching Google's
// own per-call maximum.
const AVAILABILITY_PAGE_SIZE = 250;
const AVAILABILITY_MAX_PAGES = 10;
const AVAILABILITY_MAX_EVENTS = 2500;

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

  // One provider throwing (e.g. a transient Outlook error) must not fail the
  // whole search when another provider would have answered fine.
  const settled = await Promise.allSettled(
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

  const fulfilled = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return [result.value];
    logger.warn("Provider failed to search calendar events", {
      providerType: providers[index]!.constructor.name,
      error:
        result.reason instanceof Error
          ? { message: result.reason.message, stack: result.reason.stack }
          : result.reason,
    });
    return [];
  });

  const events = fulfilled.flatMap(
    ({ events: providerEvents = [] }) => providerEvents,
  );
  // A page token belongs to whichever single provider issued it. With two
  // providers merged into one page, presenting either one's token as "the"
  // search's token would silently desync the other provider's paging on the
  // next call, so only surface it when exactly one provider actually
  // succeeded (and thus is the one to attribute it to).
  const nextPageToken =
    fulfilled.length === 1 ? (fulfilled[0]?.nextPageToken ?? null) : null;

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

  // One provider throwing must not fail availability for every other
  // connected provider — same reasoning as list_calendars and search_calendar.
  const settled = await Promise.allSettled(
    providers.map((provider) =>
      fetchAllEventsForAvailability(provider, {
        timeMin: new Date(params.startDate),
        timeMax: new Date(params.endDate),
      }),
    ),
  );

  const events = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    logger.warn("Provider failed to fetch events for availability", {
      providerType: providers[index]!.constructor.name,
      error:
        result.reason instanceof Error
          ? { message: result.reason.message, stack: result.reason.stack }
          : result.reason,
    });
    return [];
  });

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

  // Resolved before the approval gate: an account with no timezone must
  // fail fast, not burn a real human approval and then throw.
  const timeZone = resolveTimeZone(params.timeZone, account);

  const hasExternalAttendees = params.attendees?.some((email) =>
    isExternalDomain(email, account.email),
  );
  const sendInvite = params.sendInvite ?? true;

  // Determine if this should be tagged as external
  // Treat events with no attendees as "external" to avoid DharaHIL auto-rejection
  // This matches send_email behavior where all requests go through approval
  const isExternal =
    !params.attendees || params.attendees.length === 0 || hasExternalAttendees;

  // DharaHIL approval gate for ALL calendar event creates
  if (isApprovalGateRequired()) {
    logger.info("DharaHIL: Requesting approval for calendar event creation");
    logger.trace("DharaHIL: calendar event creation details", {
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
      action: decision.action,
    });
    logger.trace("DharaHIL: calendar event creation approved details", {
      title: params.title,
    });
  }

  // `notify` is the richer control; `sendInvite` is the tool's original
  // boolean and must keep working — ignoring it mails attendees against an
  // explicit instruction.
  const notify: NotifyLevel =
    params.notify ?? (params.sendInvite === false ? "none" : "all");

  const { start, end } = toEventTimeRange(
    params.startTime,
    params.endTime,
    timeZone,
  );

  const event = await providers[0]!.createEvent(
    {
      title: params.title,
      description: params.description,
      location: params.location,
      start,
      end,
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

  // One provider (typically Outlook, which doesn't support listing) throwing
  // must not take down discovery for every other connected provider.
  const settled = await Promise.allSettled(
    providers.map((p) => p.listCalendars()),
  );

  const calendars = settled.flatMap((result, index) => {
    if (result.status === "fulfilled") return result.value;
    logger.warn("Provider failed to list calendars", {
      providerType: providers[index]!.constructor.name,
      error:
        result.reason instanceof Error
          ? { message: result.reason.message, stack: result.reason.stack }
          : result.reason,
    });
    return [];
  });

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
  const eventId = extractEventId(params.eventId);

  logger.info("MCP tool: update_calendar_event", { userId: context.userId });
  logger.trace("MCP tool: update_calendar_event details", {
    eventId,
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

  // Resolved before the approval gate: an account with no timezone must
  // fail fast, not burn a real human approval and then throw.
  const timeZone =
    params.startTime || params.endTime
      ? resolveTimeZone(params.timeZone, account)
      : "";

  // DharaHIL approval gate for ALL calendar event updates
  if (isApprovalGateRequired()) {
    logger.info("DharaHIL: Requesting approval for calendar event update", {
      eventId,
    });
    logger.trace("DharaHIL: calendar event update title", {
      title: params.title,
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "update_calendar_event",
      toolArgs: {
        eventId,
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        addAttendeesCount: params.addAttendees?.length ?? 0,
        removeAttendeesCount: params.removeAttendees?.length ?? 0,
        description: params.description,
        location: params.location,
        // Resolved defaults, not raw params: the approver needs to see
        // whether this hits one occurrence or the whole series, and whether
        // every attendee gets emailed — not "undefined".
        scope: params.scope ?? "all",
        notify: params.notify ?? "all",
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: context.userId,
        stepId: "update_event",
        contextSummary: `Update calendar event ${eventId}${params.title ? `: ${params.title}` : ""}`,
        riskLevel: "MEDIUM",
        tags: ["calendar", "google", "update"],
        idempotencyKey: `calendar_update_${eventId}_${Date.now()}`,
        metadata: {
          provider: "google",
          eventId,
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
      eventId,
      action: decision.action,
    });
  }

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
    // The all-day exclusive-end-date bump (see toEventTimeRange) only makes
    // sense when both sides are being set together, same as createEvent — a
    // partial update touching just one side has no other side to compare
    // against.
    const timeFields =
      params.startTime === undefined || params.endTime === undefined
        ? {
            ...(params.startTime === undefined
              ? {}
              : { start: toEventTime(params.startTime, timeZone) }),
            ...(params.endTime === undefined
              ? {}
              : { end: toEventTime(params.endTime, timeZone) }),
          }
        : toEventTimeRange(params.startTime, params.endTime, timeZone);

    event = await providers[0]!.updateEvent(
      eventId,
      {
        ...(params.title === undefined ? {} : { title: params.title }),
        ...(params.description === undefined
          ? {}
          : { description: params.description }),
        ...(params.location === undefined ? {} : { location: params.location }),
        ...timeFields,
      },
      { notify: params.notify ?? "all", scope: params.scope },
    );
  }

  // Attendee edits are a separate, read-modify-write call: folding them into
  // the patch above would discard every guest not named in this request.
  if (params.addAttendees || params.removeAttendees) {
    event = await providers[0]!.changeAttendees(
      eventId,
      { add: params.addAttendees, remove: params.removeAttendees },
      { notify: params.notify ?? "all" },
    );
  }

  return {
    success: true,
    eventId: event?.id ?? eventId,
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
  const eventId = extractEventId(params.eventId);

  logger.info("MCP tool: delete_calendar_event", { userId: context.userId });
  logger.trace("MCP tool: delete_calendar_event details", {
    eventId,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  // DharaHIL approval gate for ALL calendar event deletes
  if (isApprovalGateRequired()) {
    logger.info("DharaHIL: Requesting approval for calendar event deletion", {
      eventId,
      scope: params.scope,
    });

    const decision = await dharahilClient.runApprovalLoop({
      toolName: "delete_calendar_event",
      toolArgs: {
        eventId,
        // Resolved defaults, not raw params: the approver needs to see
        // whether this hits one occurrence or the whole series, and whether
        // every attendee gets a cancellation email — not "undefined".
        scope: params.scope ?? "all",
        notify: params.notify ?? "all",
      },
      context: {
        agentId: "inbox-calendar-provider",
        runId: context.userId,
        stepId: "delete_event",
        contextSummary: `Delete calendar event ${eventId} (scope: ${params.scope ?? "all"})`,
        riskLevel: "HIGH",
        tags: ["calendar", "google", "delete"],
        idempotencyKey: `calendar_delete_${eventId}_${Date.now()}`,
        metadata: {
          provider: "google",
          eventId,
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
      eventId,
      action: decision.action,
    });
  }

  await providers[0]!.deleteEvent(eventId, {
    notify: params.notify ?? "all",
    scope: params.scope,
  });

  return { success: true, eventId };
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
  const eventId = extractEventId(params.eventId);

  logger.info("MCP tool: respond_to_calendar_event", {
    userId: context.userId,
  });
  logger.trace("MCP tool: respond_to_calendar_event details", {
    eventId,
    responseStatus: params.responseStatus,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  await providers[0]!.respondToEvent(eventId, {
    responseStatus: params.responseStatus,
    comment: params.comment,
    calendarId: params.calendarId,
  });

  return {
    success: true,
    eventId,
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
  const eventId = extractEventId(params.eventId);

  logger.info("MCP tool: list_calendar_event_instances", {
    userId: context.userId,
  });
  logger.trace("list_calendar_event_instances params", {
    eventId,
    from: params.from,
  });

  const { providers } = await resolveCalendarAccount({
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    from: params.from,
    logger,
  });

  const instances = await providers[0]!.listEventInstances(eventId, {
    maxResults: Math.min(Math.max(params.maxResults ?? 25, 1), 250),
    timeMin: params.timeMin,
    timeMax: params.timeMax,
  });

  return {
    instances: instances.map((instance) => ({
      eventId: instance.id,
      seriesId: instance.recurringEventId ?? eventId,
      originalStartTime: instance.originalStartTime,
      title: instance.title,
      start: instance.startTime.toISOString(),
      end: instance.endTime.toISOString(),
    })),
    count: instances.length,
  };
}

/**
 * Page through a provider's events until nextPageToken runs out or a safety
 * cap is hit. Results are ordered by start time, so stopping early at a flat
 * maxResults (as this used to) silently reports the tail of a busy range as
 * free — an agent booking against that double-books.
 */
async function fetchAllEventsForAvailability(
  provider: CalendarEventProvider,
  options: { timeMin: Date; timeMax: Date },
): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const page = await provider.fetchEvents({
      timeMin: options.timeMin,
      timeMax: options.timeMax,
      maxResults: AVAILABILITY_PAGE_SIZE,
      pageToken,
    });
    events.push(...page.events);
    pageToken = page.nextPageToken ?? undefined;
    pages += 1;

    if (pageToken && events.length >= AVAILABILITY_MAX_EVENTS) {
      logger.warn("get_calendar_availability hit the event safety cap", {
        eventCount: events.length,
        pages,
      });
      break;
    }
    if (pageToken && pages >= AVAILABILITY_MAX_PAGES) {
      logger.warn("get_calendar_availability hit the page safety cap", {
        pages,
      });
      break;
    }
  } while (pageToken);

  return events;
}

// Helper to determine if an attendee's email domain is external to the
// resolved account's own domain, rather than a single hardcoded org domain.
function isExternalDomain(email: string, accountEmail: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  // ponytail: local dev accounts use @localhost, not a real org domain.
  if (domain === "localhost") return false;
  const accountDomain = accountEmail.split("@")[1]?.toLowerCase();
  return domain !== accountDomain;
}

// Google's all-day end date is exclusive; callers give the inclusive last
// day (startTime === endTime for a one-day event), so bump it forward one
// day when both sides resolve to date-only. Sending start.date === end.date
// is rejected by Google. Shared by createCalendarEvent (always both sides)
// and updateCalendarEvent (only when both sides are being set together).
function toEventTimeRange(
  startTime: string,
  endTime: string,
  timeZone: string,
): { start: EventTime; end: EventTime } {
  const start = toEventTime(startTime, timeZone);
  const end = toEventTime(endTime, timeZone);
  const eventEnd =
    "date" in start && "date" in end ? { date: allDayEndDate(end.date) } : end;
  return { start, end: eventEnd };
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
