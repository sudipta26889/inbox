import type { EventTime, NotifyLevel } from "@/utils/calendar/event-time";
import type {
  CalendarEvent,
  CalendarEventAttendee,
} from "@/utils/calendar/event-types";

// The MCP calendar tools need full event management (recurrence scope, notify
// level, RSVP, attendee deltas, paging). Upstream's CalendarEventProvider only
// covers booking-link writes with a different contract, so these live on a
// separate interface instead of overloading upstream's method names.

export interface ManagedCalendarEvent extends Omit<CalendarEvent, "attendees"> {
  attendees: (CalendarEventAttendee & { responseStatus?: string })[];
  originalStartTime?: string;
  recurringEventId?: string;
}

export interface CalendarSummary {
  accessRole: string;
  id: string;
  primary: boolean;
  summary: string;
  timeZone: string;
}

export interface CalendarEventInput {
  attendees?: string[];
  description?: string;
  end: EventTime;
  location?: string;
  /** RFC 5545 RRULE lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"] */
  recurrence?: string[];
  start: EventTime;
  title: string;
}

/**
 * Attendee edits are expressed as a delta, never a replacement list. A whole
 * -array write to events.patch discards every attendee not named, so
 * `CalendarEventInput["attendees"]` is only ever used at creation time.
 */
export interface AttendeeChange {
  add?: string[];
  remove?: string[];
}

export type RecurrenceScope = "this" | "thisAndFollowing" | "all";

export interface CalendarEventManager {
  changeAttendees(
    eventId: string,
    change: AttendeeChange,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
    },
  ): Promise<ManagedCalendarEvent>;
  createEvent(
    input: CalendarEventInput,
    options: {
      calendarId?: string;
      idempotencyKey?: string;
      notify: NotifyLevel;
    },
  ): Promise<ManagedCalendarEvent>;
  deleteEvent(
    eventId: string,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
      scope?: RecurrenceScope;
    },
  ): Promise<void>;
  fetchEventById(eventId: string): Promise<ManagedCalendarEvent | null>;
  fetchEvents(options: {
    maxResults?: number;
    pageToken?: string;
    query?: string;
    timeMax?: Date;
    timeMin?: Date;
  }): Promise<{ events: ManagedCalendarEvent[]; nextPageToken: string | null }>;
  listCalendars(): Promise<CalendarSummary[]>;
  listEventInstances(
    eventId: string,
    options: {
      calendarId?: string;
      maxResults?: number;
      timeMax?: string;
      timeMin?: string;
    },
  ): Promise<ManagedCalendarEvent[]>;
  respondToEvent(
    eventId: string,
    options: {
      calendarId?: string;
      comment?: string;
      responseStatus: "accepted" | "declined" | "tentative";
    },
  ): Promise<void>;
  updateEvent(
    eventId: string,
    // `attendees` is deliberately excluded — use changeAttendees.
    patch: Partial<Omit<CalendarEventInput, "attendees">>,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
      scope?: RecurrenceScope;
    },
  ): Promise<ManagedCalendarEvent>;
}
