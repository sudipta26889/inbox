import type { EventTime, NotifyLevel } from "@/utils/calendar/event-time";

export interface CalendarEventAttendee {
  email: string;
  name?: string;
  responseStatus?: string;
}

export interface CalendarEvent {
  attendees: CalendarEventAttendee[];
  description?: string;
  endTime: Date;
  eventUrl?: string;
  id: string;
  location?: string;
  originalStartTime?: string;
  recurringEventId?: string;
  startTime: Date;
  title: string;
  videoConferenceLink?: string;
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

export interface CalendarEventProvider {
  changeAttendees(
    eventId: string,
    change: AttendeeChange,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
    },
  ): Promise<CalendarEvent>;
  createEvent(
    input: CalendarEventInput,
    options: {
      calendarId?: string;
      idempotencyKey?: string;
      notify: NotifyLevel;
    },
  ): Promise<CalendarEvent>;
  deleteEvent(
    eventId: string,
    options: {
      calendarId?: string;
      notify: NotifyLevel;
      scope?: RecurrenceScope;
    },
  ): Promise<void>;
  fetchEventById(eventId: string): Promise<CalendarEvent | null>;
  fetchEvents(options: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }): Promise<CalendarEvent[]>;
  fetchEventsWithAttendee(options: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]>;
  listCalendars(): Promise<CalendarSummary[]>;
  listEventInstances(
    eventId: string,
    options: {
      calendarId?: string;
      maxResults?: number;
      timeMax?: string;
      timeMin?: string;
    },
  ): Promise<CalendarEvent[]>;
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
  ): Promise<CalendarEvent>;
}
