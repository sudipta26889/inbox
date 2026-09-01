import type { calendar_v3 } from "@googleapis/calendar";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import { toSendUpdates } from "@/utils/calendar/event-time";
import type { NotifyLevel } from "@/utils/calendar/event-time";
import type {
  AttendeeChange,
  CalendarEvent,
  CalendarEventInput,
  CalendarEventProvider,
  CalendarSummary,
  RecurrenceScope,
} from "@/utils/calendar/event-types";
import type { Logger } from "@/utils/logger";

export interface GoogleCalendarConnectionParams {
  accessToken: string | null;
  emailAccountId: string;
  expiresAt: number | null;
  refreshToken: string | null;
}

export class GoogleCalendarEventProvider implements CalendarEventProvider {
  // Google accepts base32hex ids only: lowercase a-v and 0-9, 5-1024 chars.
  private static readonly ID_PATTERN = /^[a-v0-9]{5,1024}$/;

  private readonly connection: GoogleCalendarConnectionParams;
  private readonly logger: Logger;

  constructor(connection: GoogleCalendarConnectionParams, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  private async getClient(): Promise<calendar_v3.Calendar> {
    return getCalendarClientWithRefresh({
      accessToken: this.connection.accessToken,
      refreshToken: this.connection.refreshToken,
      expiresAt: this.connection.expiresAt,
      emailAccountId: this.connection.emailAccountId,
      logger: this.logger,
    });
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    const client = await this.getClient();
    const response = await client.calendarList.list({ maxResults: 250 });

    return (response.data.items ?? []).map((item) => ({
      id: item.id ?? "",
      summary: item.summary ?? "",
      timeZone: item.timeZone ?? "",
      primary: item.primary ?? false,
      accessRole: item.accessRole ?? "",
    }));
  }

  async createEvent(
    input: CalendarEventInput,
    options: {
      calendarId?: string;
      idempotencyKey?: string;
      notify: NotifyLevel;
    },
  ): Promise<CalendarEvent> {
    if (
      options.idempotencyKey &&
      !GoogleCalendarEventProvider.ID_PATTERN.test(options.idempotencyKey)
    ) {
      throw new Error(
        "idempotencyKey must be 5-1024 characters using only a-v and 0-9 (Google's base32hex event id format).",
      );
    }

    const client = await this.getClient();
    const response = await client.events.insert({
      calendarId: options.calendarId ?? "primary",
      sendUpdates: toSendUpdates(options.notify),
      requestBody: {
        ...(options.idempotencyKey ? { id: options.idempotencyKey } : {}),
        summary: input.title,
        description: input.description,
        location: input.location,
        start: input.start,
        end: input.end,
        recurrence: input.recurrence,
        attendees: input.attendees?.map((email) => ({ email })),
      },
    });

    return this.parseEvent(response.data);
  }

  async updateEvent(
    eventId: string,
    // `attendees` is deliberately excluded — use changeAttendees.
    patch: Partial<Omit<CalendarEventInput, "attendees">>,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
      scope?: RecurrenceScope;
    },
  ): Promise<CalendarEvent> {
    // Same hazard as deleteEvent: patching a series master with
    // scope 'thisAndFollowing' rewrites every occurrence, past included.
    if (options.scope === "thisAndFollowing") {
      throw new Error(
        "scope 'thisAndFollowing' is not supported for updateEvent. Use list_calendar_event_instances and update each occurrence with scope 'this'.",
      );
    }

    const client = await this.getClient();
    const response = await client.events.patch({
      calendarId: options.calendarId ?? "primary",
      eventId,
      sendUpdates: toSendUpdates(options.notify),
      requestBody: {
        ...(patch.title === undefined ? {} : { summary: patch.title }),
        ...(patch.description === undefined
          ? {}
          : { description: patch.description }),
        ...(patch.location === undefined ? {} : { location: patch.location }),
        ...(patch.start === undefined ? {} : { start: patch.start }),
        ...(patch.end === undefined ? {} : { end: patch.end }),
        ...(patch.recurrence === undefined
          ? {}
          : { recurrence: patch.recurrence }),
      },
    });

    return this.parseEvent(response.data);
  }

  /**
   * Attendee changes are deltas, never a whole-array write.
   *
   * `events.patch` documents that "array fields, if specified, overwrite the
   * existing arrays; this discards any previous array elements". Passing the
   * attendees an agent happens to mention would silently uninvite everyone
   * else on the event, so we read the current list and merge.
   */
  async changeAttendees(
    eventId: string,
    change: AttendeeChange,
    options: { calendarId?: string; notify: NotifyLevel },
  ): Promise<CalendarEvent> {
    const client = await this.getClient();
    const calendarId = options.calendarId ?? "primary";

    const current = await client.events.get({ calendarId, eventId });
    const existing = current.data.attendees ?? [];

    const removals = new Set(
      (change.remove ?? []).map((email) => email.toLowerCase()),
    );
    const kept = existing.filter(
      (a) => !removals.has((a.email ?? "").toLowerCase()),
    );
    const present = new Set(kept.map((a) => (a.email ?? "").toLowerCase()));
    const additions = (change.add ?? [])
      .filter((email) => !present.has(email.toLowerCase()))
      .map((email) => ({ email }));

    const response = await client.events.patch({
      calendarId,
      eventId,
      sendUpdates: toSendUpdates(options.notify),
      requestBody: { attendees: [...kept, ...additions] },
    });

    return this.parseEvent(response.data);
  }

  async deleteEvent(
    eventId: string,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
      scope?: RecurrenceScope;
    },
  ): Promise<void> {
    const client = await this.getClient();
    const calendarId = options.calendarId ?? "primary";

    // Google has no single-call "this and following" delete — it needs a
    // two-call RRULE trim plus re-insert. Falling through to events.delete
    // would destroy the whole series when the caller asked to keep history,
    // so refuse loudly instead.
    if (options.scope === "thisAndFollowing") {
      throw new Error(
        "scope 'thisAndFollowing' is not supported for deleteEvent. Use list_calendar_event_instances and delete each occurrence with scope 'this', or scope 'all' to remove the series.",
      );
    }

    // Cancelling one occurrence is a patch on the instance, not a delete of
    // the series. A delete here would silently remove every occurrence.
    if (options.scope === "this") {
      // Google cancels whatever id it is given. A master id here would cancel
      // the entire series, so require the per-occurrence form.
      if (!/_\d{8}T\d{6}Z$/.test(eventId)) {
        throw new Error(
          "scope 'this' requires a per-occurrence eventId from list_calendar_event_instances, not a series id. Pass scope 'all' to remove the whole series.",
        );
      }

      await client.events.patch({
        calendarId,
        eventId,
        sendUpdates: toSendUpdates(options.notify),
        requestBody: { status: "cancelled" },
      });
      return;
    }

    await client.events.delete({
      calendarId,
      eventId,
      sendUpdates: toSendUpdates(options.notify),
    });
  }

  async respondToEvent(
    eventId: string,
    options: {
      calendarId?: string;
      comment?: string;
      responseStatus: "accepted" | "declined" | "tentative";
    },
  ): Promise<void> {
    const client = await this.getClient();
    const calendarId = options.calendarId ?? "primary";

    // Google has no RSVP endpoint: an attendee patches their own row, found
    // via attendees[].self. Everything else on the event is organizer-owned.
    const current = await client.events.get({ calendarId, eventId });
    const attendees = current.data.attendees ?? [];
    const me = attendees.find((a) => a.self);

    if (!me) {
      throw new Error(
        "You are not an attendee of this event, so you cannot RSVP to it.",
      );
    }

    await client.events.patch({
      calendarId,
      eventId,
      sendUpdates: "all",
      requestBody: {
        attendees: attendees.map((a) =>
          a.self
            ? {
                ...a,
                responseStatus: options.responseStatus,
                // Only overwrite the comment when one was supplied — an
                // unconditional write erases a prior RSVP comment.
                ...(options.comment === undefined
                  ? {}
                  : { comment: options.comment }),
              }
            : a,
        ),
      },
    });
  }

  async listEventInstances(
    eventId: string,
    options: {
      calendarId?: string;
      maxResults?: number;
      timeMax?: string;
      timeMin?: string;
    },
  ): Promise<CalendarEvent[]> {
    const client = await this.getClient();
    const response = await client.events.instances({
      calendarId: options.calendarId ?? "primary",
      eventId,
      maxResults: options.maxResults ?? 50,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
    });

    return (response.data.items ?? []).map((event) => this.parseEvent(event));
  }

  async fetchEventsWithAttendee({
    attendeeEmail,
    timeMin,
    timeMax,
    maxResults,
  }: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]> {
    const client = await this.getClient();

    const response = await client.events.list({
      calendarId: "primary",
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      q: attendeeEmail,
    });

    const events = response.data.items || [];

    // Filter to events that actually have this attendee
    return events
      .filter((event) =>
        event.attendees?.some(
          (a) => a.email?.toLowerCase() === attendeeEmail.toLowerCase(),
        ),
      )
      .map((event) => this.parseEvent(event));
  }

  async fetchEvents({
    timeMin = new Date(),
    timeMax,
    maxResults,
    pageToken,
    query,
  }: {
    maxResults?: number;
    pageToken?: string;
    query?: string;
    timeMax?: Date;
    timeMin?: Date;
  }): Promise<{ events: CalendarEvent[]; nextPageToken: string | null }> {
    const client = await this.getClient();

    const response = await client.events.list({
      calendarId: "primary",
      timeMin: timeMin?.toISOString(),
      timeMax: timeMax?.toISOString(),
      maxResults: Math.min(maxResults || 50, 2500),
      pageToken,
      q: query,
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = response.data.items || [];

    return {
      events: events.map((event) => this.parseEvent(event)),
      nextPageToken: response.data.nextPageToken ?? null,
    };
  }

  async fetchEventById(eventId: string): Promise<CalendarEvent | null> {
    try {
      const client = await this.getClient();

      this.logger.info("Fetching event from Google Calendar API", {
        eventId,
        calendarId: "primary",
      });

      const response = await client.events.get({
        calendarId: "primary",
        eventId,
      });

      if (!response.data) {
        this.logger.warn("Google Calendar API returned no data", { eventId });
        return null;
      }

      this.logger.info("Event fetched successfully from Google Calendar", {
        eventId,
        title: response.data.summary,
      });

      return this.parseEvent(response.data);
    } catch (error) {
      this.logger.error("Failed to fetch event from Google Calendar", {
        eventId,
        error:
          error instanceof Error
            ? {
                message: error.message,
                stack: error.stack,
                name: error.name,
              }
            : error,
        fullError: JSON.stringify(error),
      });
      return null;
    }
  }

  private parseEvent(event: calendar_v3.Schema$Event) {
    const startTime = new Date(
      event.start?.dateTime || event.start?.date || Date.now(),
    );
    const endTime = new Date(
      event.end?.dateTime || event.end?.date || Date.now(),
    );

    let videoConferenceLink = event.hangoutLink ?? undefined;
    if (event.conferenceData?.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(
        (entry) => entry.entryPointType === "video",
      );
      videoConferenceLink = videoEntry?.uri ?? videoConferenceLink;
    }

    return {
      id: event.id || "",
      title: event.summary || "Untitled",
      description: event.description || undefined,
      location: event.location || undefined,
      eventUrl: event.htmlLink || undefined,
      videoConferenceLink,
      startTime,
      endTime,
      attendees:
        event.attendees?.map((attendee) => ({
          email: attendee.email || "",
          name: attendee.displayName ?? undefined,
          responseStatus: attendee.responseStatus ?? undefined,
        })) || [],
      recurringEventId: event.recurringEventId ?? undefined,
      originalStartTime:
        event.originalStartTime?.dateTime ??
        event.originalStartTime?.date ??
        undefined,
    };
  }
}
