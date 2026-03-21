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
  startTime: Date;
  title: string;
  videoConferenceLink?: string;
}

export interface CalendarEventProvider {
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
}
