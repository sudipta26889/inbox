import type { Client } from "@microsoft/microsoft-graph-client";
import { getCalendarClientWithRefresh } from "@/utils/outlook/calendar-client";
import type {
  CalendarEvent,
  CalendarEventProvider,
  CalendarSummary,
} from "@/utils/calendar/event-types";
import { CalendarWriteUnsupportedError } from "@/utils/calendar/errors";
import type { Logger } from "@/utils/logger";

export interface MicrosoftCalendarConnectionParams {
  accessToken: string | null;
  emailAccountId: string;
  expiresAt: number | null;
  refreshToken: string | null;
}

type MicrosoftEvent = {
  id?: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: Array<{
    emailAddress?: { address?: string; name?: string };
    status?: { response?: string };
  }>;
  location?: { displayName?: string };
  webLink?: string;
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
};

export class MicrosoftCalendarEventProvider implements CalendarEventProvider {
  private readonly connection: MicrosoftCalendarConnectionParams;
  private readonly logger: Logger;

  constructor(connection: MicrosoftCalendarConnectionParams, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  private async getClient(): Promise<Client> {
    return getCalendarClientWithRefresh({
      accessToken: this.connection.accessToken,
      refreshToken: this.connection.refreshToken,
      expiresAt: this.connection.expiresAt,
      emailAccountId: this.connection.emailAccountId,
      logger: this.logger,
    });
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

    // Use calendarView endpoint which correctly returns events overlapping the time range
    const response = await client
      .api("/me/calendar/calendarView")
      .query({
        startDateTime: timeMin.toISOString(),
        endDateTime: timeMax.toISOString(),
      })
      .top(maxResults * 3) // Fetch more to filter by attendee
      .orderby("start/dateTime")
      .get();

    const events: MicrosoftEvent[] = response.value || [];

    // Filter to events that have this attendee
    return events
      .filter((event) =>
        event.attendees?.some(
          (a) =>
            a.emailAddress?.address?.toLowerCase() ===
            attendeeEmail.toLowerCase(),
        ),
      )
      .slice(0, maxResults)
      .map((event) => this.parseEvent(event));
  }

  async fetchEvents({
    timeMin = new Date(),
    timeMax,
    maxResults,
    query,
  }: {
    maxResults?: number;
    // ponytail: Outlook pagination not implemented (calendarView paginates
    // via @odata.nextLink, not an opaque token). Add nextLink support if
    // Outlook calendars need paging beyond `top`.
    pageToken?: string;
    query?: string;
    timeMax?: Date;
    timeMin?: Date;
  }): Promise<{ events: CalendarEvent[]; nextPageToken: string | null }> {
    const client = await this.getClient();

    // calendarView requires both start and end times, default to 30 days from timeMin
    const effectiveTimeMax =
      timeMax ?? new Date(timeMin.getTime() + 30 * 24 * 60 * 60 * 1000);

    // Use calendarView endpoint which correctly returns events overlapping the time range
    const response = await client
      .api("/me/calendar/calendarView")
      .query({
        startDateTime: timeMin.toISOString(),
        endDateTime: effectiveTimeMax.toISOString(),
      })
      .top(maxResults || 100)
      .orderby("start/dateTime")
      .get();

    const events: MicrosoftEvent[] = response.value || [];

    // ponytail: calendarView has no free-text search parameter (unlike
    // Google's server-side `q`), so filter client-side on title/description
    // /location. Without this, `query` is silently ignored and every event
    // in range is returned as a "match".
    const matched = query
      ? events.filter((event) => matchesQuery(event, query))
      : events;

    return {
      events: matched.map((event) => this.parseEvent(event)),
      nextPageToken: null,
    };
  }

  async fetchEventById(eventId: string): Promise<CalendarEvent | null> {
    try {
      const client = await this.getClient();

      const response = await client.api(`/me/events/${eventId}`).get();

      if (!response) {
        return null;
      }

      return this.parseEvent(response as MicrosoftEvent);
    } catch (error) {
      this.logger.trace("Event not found in Microsoft Calendar", {
        eventId,
        error,
      });
      return null;
    }
  }

  async listCalendars(): Promise<CalendarSummary[]> {
    throw new CalendarWriteUnsupportedError("Outlook", "listing");
  }

  async createEvent(): Promise<CalendarEvent> {
    throw new CalendarWriteUnsupportedError("Outlook", "event creation");
  }

  async updateEvent(): Promise<CalendarEvent> {
    throw new CalendarWriteUnsupportedError("Outlook", "event update");
  }

  async deleteEvent(): Promise<void> {
    throw new CalendarWriteUnsupportedError("Outlook", "event deletion");
  }

  async respondToEvent(): Promise<void> {
    throw new CalendarWriteUnsupportedError("Outlook", "RSVP");
  }

  async listEventInstances(): Promise<CalendarEvent[]> {
    throw new CalendarWriteUnsupportedError("Outlook", "instance listing");
  }

  async changeAttendees(): Promise<CalendarEvent> {
    throw new CalendarWriteUnsupportedError("Outlook", "attendee change");
  }

  private parseEvent(event: MicrosoftEvent) {
    return {
      id: event.id || "",
      title: event.subject || "Untitled",
      description: event.bodyPreview || undefined,
      location: event.location?.displayName || undefined,
      eventUrl: event.webLink || undefined,
      videoConferenceLink:
        event.onlineMeeting?.joinUrl || event.onlineMeetingUrl || undefined,
      startTime: new Date(event.start?.dateTime || Date.now()),
      endTime: new Date(event.end?.dateTime || Date.now()),
      attendees:
        event.attendees?.map((attendee) => ({
          email: attendee.emailAddress?.address || "",
          name: attendee.emailAddress?.name ?? undefined,
          responseStatus: attendee.status?.response ?? undefined,
        })) || [],
    };
  }
}

function matchesQuery(event: MicrosoftEvent, query: string): boolean {
  const needle = query.toLowerCase();
  return [event.subject, event.bodyPreview, event.location?.displayName].some(
    (field) => field?.toLowerCase().includes(needle),
  );
}
