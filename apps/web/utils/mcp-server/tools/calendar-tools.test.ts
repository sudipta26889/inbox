import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendars,
  respondToCalendarEvent,
  searchCalendar,
  updateCalendarEvent,
} from "./calendar-tools";
import type { McpToolContext } from "./registry";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_DHARAHIL_ENABLED: false } }));

const provider = {
  createEvent: vi.fn(),
  fetchEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  changeAttendees: vi.fn(),
  respondToEvent: vi.fn(),
  listCalendars: vi.fn(),
};
const resolve = vi.fn();
vi.mock("@/utils/calendar/resolve-account", () => ({
  resolveCalendarAccount: (...a: unknown[]) => resolve(...a),
}));

const context: McpToolContext = {
  clientId: "c",
  emailAccountId: "acct-1",
  scopes: ["calendar:write"],
  userId: "user-1",
};

describe("createCalendarEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
    provider.createEvent.mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date("2026-09-02T08:30:00Z"),
      endTime: new Date("2026-09-02T09:30:00Z"),
      attendees: [],
    });
  });

  it("uses the account timezone rather than hardcoding UTC", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
    });

    const [input] = provider.createEvent.mock.calls[0];
    expect(input.start).toEqual({
      dateTime: "2026-09-02T14:00:00",
      timeZone: "Asia/Kolkata",
    });
  });

  it("lets an explicit timeZone override the account default", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      timeZone: "Europe/London",
    });

    expect(provider.createEvent.mock.calls[0][0].start.timeZone).toBe(
      "Europe/London",
    );
  });

  it("defaults notify to all so invites actually reach attendees", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      attendees: ["a@x.com"],
    });

    expect(provider.createEvent.mock.calls[0][1].notify).toBe("all");
  });

  it("honours sendInvite: false so no one is emailed against an explicit instruction", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      attendees: ["a@x.com"],
      sendInvite: false,
    });

    expect(provider.createEvent.mock.calls[0][1].notify).toBe("none");
  });

  it("lets an explicit notify win over sendInvite: false", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      attendees: ["a@x.com"],
      sendInvite: false,
      notify: "external",
    });

    expect(provider.createEvent.mock.calls[0][1].notify).toBe("external");
  });

  it("fails clearly when no timezone can be resolved", async () => {
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: null },
      providers: [provider],
    });

    await expect(
      createCalendarEvent(context, {
        title: "Sync",
        startTime: "2026-09-02T14:00:00",
        endTime: "2026-09-02T15:00:00",
      }),
    ).rejects.toThrow("Timezone");
  });
});

describe("searchCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
  });

  it("passes the query to the provider instead of filtering after the fact", async () => {
    provider.fetchEvents.mockResolvedValue([]);

    await searchCalendar(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
      query: "standup",
    });

    expect(provider.fetchEvents.mock.calls[0][0].query).toBe("standup");
  });

  it("honours maxResults instead of a hardcoded 50", async () => {
    provider.fetchEvents.mockResolvedValue({ events: [], nextPageToken: null });

    await searchCalendar(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
      maxResults: 200,
    });

    expect(provider.fetchEvents.mock.calls[0][0].maxResults).toBe(200);
  });

  it("surfaces nextPageToken so the model can page rather than truncate", async () => {
    provider.fetchEvents.mockResolvedValue({
      events: [],
      nextPageToken: "tok-2",
    });

    const result = await searchCalendar(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
    });

    expect(result.nextPageToken).toBe("tok-2");
  });

  it("passes a supplied pageToken through", async () => {
    provider.fetchEvents.mockResolvedValue({ events: [], nextPageToken: null });

    await searchCalendar(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
      pageToken: "tok-2",
    });

    expect(provider.fetchEvents.mock.calls[0][0].pageToken).toBe("tok-2");
  });
});

describe("calendar write tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
  });

  it("defaults update notify to all, never to the lossy 'none'", async () => {
    // Google warns 'none' can stop events syncing or lose them entirely, so
    // it must be an explicit agent choice rather than our default.
    provider.updateEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Renamed",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await updateCalendarEvent(context, { eventId: "evt-1", title: "Renamed" });

    expect(provider.updateEvent.mock.calls[0][2].notify).toBe("all");
  });

  it("still lets the agent opt into silence", async () => {
    provider.updateEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Renamed",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await updateCalendarEvent(context, {
      eventId: "evt-1",
      title: "Renamed",
      notify: "none",
    });

    expect(provider.updateEvent.mock.calls[0][2].notify).toBe("none");
  });

  it("routes attendee changes through changeAttendees, never through the patch", async () => {
    // A whole-array write via updateEvent's patch would silently uninvite
    // every attendee not named in this call, so add/remove must go through
    // the dedicated delta call instead.
    provider.updateEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });
    provider.changeAttendees = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await updateCalendarEvent(context, {
      eventId: "evt-1",
      addAttendees: ["new@x.com"],
      removeAttendees: ["old@x.com"],
    });

    expect(provider.updateEvent.mock.calls[0][1]).not.toHaveProperty(
      "attendees",
    );
    expect(provider.changeAttendees).toHaveBeenCalledWith(
      "evt-1",
      { add: ["new@x.com"], remove: ["old@x.com"] },
      { notify: "all" },
    );
  });

  it("defaults delete notify to all so cancellations are delivered", async () => {
    provider.deleteEvent = vi.fn().mockResolvedValue(undefined);

    await deleteCalendarEvent(context, { eventId: "evt-1" });

    expect(provider.deleteEvent.mock.calls[0][1].notify).toBe("all");
  });

  it("passes recurrence scope through to the provider", async () => {
    provider.deleteEvent = vi.fn().mockResolvedValue(undefined);

    await deleteCalendarEvent(context, { eventId: "evt-1", scope: "this" });

    expect(provider.deleteEvent.mock.calls[0][1].scope).toBe("this");
  });

  it("RSVPs without touching anything else on the event", async () => {
    provider.respondToEvent = vi.fn().mockResolvedValue(undefined);

    await respondToCalendarEvent(context, {
      eventId: "evt-1",
      responseStatus: "accepted",
    });

    expect(provider.respondToEvent).toHaveBeenCalledWith("evt-1", {
      responseStatus: "accepted",
      comment: undefined,
      calendarId: undefined,
    });
  });

  it("lists calendars with primary and accessRole", async () => {
    provider.listCalendars = vi.fn().mockResolvedValue([
      {
        id: "c1",
        summary: "Me",
        timeZone: "Asia/Kolkata",
        primary: true,
        accessRole: "owner",
      },
    ]);

    const result = await listCalendars(context, {});

    expect(result.calendars[0]).toMatchObject({
      id: "c1",
      primary: true,
      accessRole: "owner",
    });
  });
});
