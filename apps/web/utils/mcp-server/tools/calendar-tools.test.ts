import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  getCalendarAvailability,
  listCalendarEventInstances,
  listCalendars,
  respondToCalendarEvent,
  searchCalendar,
  updateCalendarEvent,
} from "./calendar-tools";
import type { McpToolContext } from "./registry";
import { env } from "@/env";
import { dharahilClient } from "@/utils/dharahil/client";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_DHARAHIL_ENABLED: false } }));
vi.mock("@/utils/dharahil/client", () => ({
  dharahilClient: {
    runApprovalLoop: vi.fn(),
    wasDenied: vi.fn(() => false),
    shouldRevise: vi.fn(() => false),
  },
}));

// `env`'s real type is readonly (t3-env); the mock above is a plain mutable
// object at runtime, so route the flip through a cast rather than fighting
// the type in every test.
function setDharahilEnabled(value: boolean) {
  (
    env as { NEXT_PUBLIC_DHARAHIL_ENABLED: boolean }
  ).NEXT_PUBLIC_DHARAHIL_ENABLED = value;
}

const provider = {
  createEvent: vi.fn(),
  fetchEvents: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  changeAttendees: vi.fn(),
  respondToEvent: vi.fn(),
  listCalendars: vi.fn(),
  listEventInstances: vi.fn(),
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

  it("makes the all-day end date exclusive so Google does not reject start === end", async () => {
    // toEventTime passes bare dates through untouched, so a one-day all-day
    // event's start.date and end.date arrive equal — Google rejects that.
    await createCalendarEvent(context, {
      title: "Offsite",
      startTime: "2026-09-02",
      endTime: "2026-09-02",
    });

    const [input] = provider.createEvent.mock.calls[0];
    expect(input.start).toEqual({ date: "2026-09-02" });
    expect(input.end).toEqual({ date: "2026-09-03" });
  });

  it("leaves timed events untouched by the all-day end-date bump", async () => {
    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
    });

    const [input] = provider.createEvent.mock.calls[0];
    expect(input.end).toEqual({
      dateTime: "2026-09-02T15:00:00",
      timeZone: "Asia/Kolkata",
    });
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

  it("suppresses nextPageToken when two providers ran, since the token belongs to only one of them", async () => {
    const secondProvider = { fetchEvents: vi.fn() };
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider, secondProvider],
    });
    provider.fetchEvents.mockResolvedValue({
      events: [],
      nextPageToken: "google-tok",
    });
    secondProvider.fetchEvents.mockResolvedValue({
      events: [],
      nextPageToken: null,
    });

    const result = await searchCalendar(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-30T00:00:00Z",
    });

    expect(result.nextPageToken).toBeNull();
  });
});

describe("getCalendarAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
  });

  it("pages through nextPageToken so later pages are not reported as free", async () => {
    // Results come back ordered by start time. A hardcoded single-page fetch
    // would silently drop this second page's busy block, reporting that
    // slot as free.
    provider.fetchEvents = vi
      .fn()
      .mockResolvedValueOnce({
        events: [
          {
            id: "e1",
            title: "Early meeting",
            startTime: new Date("2026-09-01T01:00:00Z"),
            endTime: new Date("2026-09-01T02:00:00Z"),
            attendees: [],
          },
        ],
        nextPageToken: "tok-2",
      })
      .mockResolvedValueOnce({
        events: [
          {
            id: "e2",
            title: "Late meeting",
            startTime: new Date("2026-09-01T10:00:00Z"),
            endTime: new Date("2026-09-01T11:00:00Z"),
            attendees: [],
          },
        ],
        nextPageToken: null,
      });

    const result = await getCalendarAvailability(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-01T23:00:00Z",
    });

    expect(provider.fetchEvents).toHaveBeenCalledTimes(2);
    expect(result.busy.map((b) => b.summary)).toEqual([
      "Early meeting",
      "Late meeting",
    ]);
  });

  it("stops at the page safety cap and warns rather than looping forever", async () => {
    provider.fetchEvents = vi.fn().mockResolvedValue({
      events: [
        {
          id: "e",
          title: "Busy",
          startTime: new Date("2026-09-01T01:00:00Z"),
          endTime: new Date("2026-09-01T02:00:00Z"),
          attendees: [],
        },
      ],
      nextPageToken: "keeps-going",
    });

    await getCalendarAvailability(context, {
      startDate: "2026-09-01T00:00:00Z",
      endDate: "2026-09-01T23:00:00Z",
    });

    expect(provider.fetchEvents).toHaveBeenCalledTimes(10);
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
      title: "Renamed",
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

  it("skips updateEvent entirely for an attendee-only update, avoiding a second notification email", async () => {
    // An empty-bodied updateEvent call still triggers Google's per-request
    // sendUpdates, so adding a guest would otherwise mail everyone twice.
    provider.updateEvent = vi.fn();
    provider.changeAttendees = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    const result = await updateCalendarEvent(context, {
      eventId: "evt-1",
      addAttendees: ["new@x.com"],
    });

    expect(provider.updateEvent).not.toHaveBeenCalled();
    expect(provider.changeAttendees).toHaveBeenCalledWith(
      "evt-1",
      { add: ["new@x.com"], remove: undefined },
      { notify: "all" },
    );
    expect(result).toEqual({
      success: true,
      eventId: "evt-1",
      eventUrl: "",
    });
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

  it("returns the working provider's calendars when another provider throws", async () => {
    // Promise.all would make one throwing provider (e.g. Outlook, which
    // doesn't support listing) fail this read-only discovery tool entirely,
    // even though Google would have answered fine.
    const workingProvider = {
      listCalendars: vi.fn().mockResolvedValue([
        {
          id: "c1",
          summary: "Me",
          timeZone: "Asia/Kolkata",
          primary: true,
          accessRole: "owner",
        },
      ]),
    };
    const brokenProvider = {
      listCalendars: vi
        .fn()
        .mockRejectedValue(new Error("listing not supported for Outlook")),
    };
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [brokenProvider, workingProvider],
    });

    const result = await listCalendars(context, {});

    expect(result.calendars).toHaveLength(1);
    expect(result.calendars[0]).toMatchObject({ id: "c1" });
    expect(result.count).toBe(1);
  });
});

describe("listCalendarEventInstances", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
  });

  it("returns per-occurrence ids that the edit tools accept", async () => {
    provider.listEventInstances = vi.fn().mockResolvedValue([
      {
        id: "evt-1_20260902T083000Z",
        title: "Standup",
        startTime: new Date("2026-09-02T08:30:00Z"),
        endTime: new Date("2026-09-02T09:00:00Z"),
        attendees: [],
        recurringEventId: "evt-1",
        originalStartTime: "2026-09-02T14:00:00+05:30",
      },
    ]);

    const result = await listCalendarEventInstances(context, {
      eventId: "evt-1",
    });

    expect(result.instances[0]).toMatchObject({
      eventId: "evt-1_20260902T083000Z",
      seriesId: "evt-1",
      originalStartTime: "2026-09-02T14:00:00+05:30",
      title: "Standup",
      start: "2026-09-02T08:30:00.000Z",
      end: "2026-09-02T09:00:00.000Z",
    });
    expect(result.count).toBe(1);
  });

  it("clamps maxResults to [1, 250] and defaults it to 25", async () => {
    provider.listEventInstances = vi.fn().mockResolvedValue([]);

    await listCalendarEventInstances(context, { eventId: "evt-1" });
    expect(provider.listEventInstances.mock.calls[0][1].maxResults).toBe(25);

    await listCalendarEventInstances(context, {
      eventId: "evt-1",
      maxResults: 9999,
    });
    expect(provider.listEventInstances.mock.calls[1][1].maxResults).toBe(250);

    await listCalendarEventInstances(context, {
      eventId: "evt-1",
      maxResults: 0,
    });
    expect(provider.listEventInstances.mock.calls[2][1].maxResults).toBe(1);
  });
});

describe("Calendar URL support beyond get_calendar_event", () => {
  // getCalendarEvent already ran extractEventId; these four handlers gained
  // it in the same pass, so a pasted Google Calendar URL now works on them
  // too instead of 404ing against the provider.
  const url = "https://calendar.google.com/calendar/event?eid=ABC123xyz";

  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
  });

  it("updateCalendarEvent extracts the eventId from a Calendar URL", async () => {
    provider.updateEvent = vi.fn().mockResolvedValue({
      id: "ABC123xyz",
      title: "Renamed",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    const result = await updateCalendarEvent(context, {
      eventId: url,
      title: "Renamed",
    });

    expect(provider.updateEvent.mock.calls[0][0]).toBe("ABC123xyz");
    expect(result.eventId).toBe("ABC123xyz");
  });

  it("deleteCalendarEvent extracts the eventId from a Calendar URL", async () => {
    provider.deleteEvent = vi.fn().mockResolvedValue(undefined);

    const result = await deleteCalendarEvent(context, { eventId: url });

    expect(provider.deleteEvent.mock.calls[0][0]).toBe("ABC123xyz");
    expect(result.eventId).toBe("ABC123xyz");
  });

  it("respondToCalendarEvent extracts the eventId from a Calendar URL", async () => {
    provider.respondToEvent = vi.fn().mockResolvedValue(undefined);

    const result = await respondToCalendarEvent(context, {
      eventId: url,
      responseStatus: "accepted",
    });

    expect(provider.respondToEvent.mock.calls[0][0]).toBe("ABC123xyz");
    expect(result.eventId).toBe("ABC123xyz");
  });

  it("listCalendarEventInstances extracts the eventId from a Calendar URL", async () => {
    provider.listEventInstances = vi.fn().mockResolvedValue([]);

    await listCalendarEventInstances(context, { eventId: url });

    expect(provider.listEventInstances.mock.calls[0][0]).toBe("ABC123xyz");
  });
});

describe("DharaHIL approval gate content", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: "Asia/Kolkata" },
      providers: [provider],
    });
    (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mockResolvedValue({ action: "APPROVED" });
  });

  afterEach(() => {
    // Shared mutable mock object — every other test in this file assumes
    // DharaHIL is off, so it must not leak past this describe block.
    setDharahilEnabled(false);
  });

  it("shows the resolved scope and notify default, not raw undefined, on update", async () => {
    setDharahilEnabled(true);
    provider.updateEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Renamed",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await updateCalendarEvent(context, { eventId: "evt-1", title: "Renamed" });

    const [{ toolArgs }] = (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(toolArgs.scope).toBe("all");
    expect(toolArgs.notify).toBe("all");
  });

  it("shows attendee counts rather than raw arrays on update", async () => {
    setDharahilEnabled(true);
    provider.changeAttendees = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await updateCalendarEvent(context, {
      eventId: "evt-1",
      addAttendees: ["a@x.com", "b@x.com"],
      removeAttendees: ["c@x.com"],
    });

    const [{ toolArgs }] = (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(toolArgs.addAttendeesCount).toBe(2);
    expect(toolArgs.removeAttendeesCount).toBe(1);
  });

  it("shows the resolved scope and notify default, not raw undefined, on delete", async () => {
    setDharahilEnabled(true);
    provider.deleteEvent = vi.fn().mockResolvedValue(undefined);

    await deleteCalendarEvent(context, { eventId: "evt-1" });

    const [{ toolArgs }] = (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(toolArgs.scope).toBe("all");
    expect(toolArgs.notify).toBe("all");
  });

  it("classifies an attendee on the account's own domain as internal", async () => {
    setDharahilEnabled(true);
    provider.createEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      attendees: ["colleague@x.com"], // same domain as account email me@x.com
    });

    const [{ context: dharahilContext }] = (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(dharahilContext.metadata.has_external_attendees).toBe("false");
    expect(dharahilContext.riskLevel).toBe("MEDIUM");
  });

  it("classifies an attendee on a different domain as external, not a hardcoded org domain", async () => {
    setDharahilEnabled(true);
    provider.createEvent = vi.fn().mockResolvedValue({
      id: "evt-1",
      title: "Sync",
      startTime: new Date(),
      endTime: new Date(),
      attendees: [],
    });

    await createCalendarEvent(context, {
      title: "Sync",
      startTime: "2026-09-02T14:00:00",
      endTime: "2026-09-02T15:00:00",
      attendees: ["outsider@other.com"], // different domain than account email me@x.com
    });

    const [{ context: dharahilContext }] = (
      dharahilClient.runApprovalLoop as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(dharahilContext.metadata.has_external_attendees).toBe("true");
    expect(dharahilContext.riskLevel).toBe("HIGH");
  });
});

describe("resolveTimeZone runs before the DharaHIL approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolve.mockResolvedValue({
      account: { id: "acct-1", email: "me@x.com", timezone: null },
      providers: [provider],
    });
  });

  afterEach(() => {
    // This is a shared mutable mock object — every other test in this file
    // assumes DharaHIL is off, so it must not leak past this describe block.
    setDharahilEnabled(false);
  });

  it("createCalendarEvent fails fast on a missing timezone instead of spending a real human approval", async () => {
    setDharahilEnabled(true);

    await expect(
      createCalendarEvent(context, {
        title: "Sync",
        startTime: "2026-09-02T14:00:00",
        endTime: "2026-09-02T15:00:00",
      }),
    ).rejects.toThrow("Timezone");

    expect(dharahilClient.runApprovalLoop).not.toHaveBeenCalled();
  });

  it("updateCalendarEvent fails fast on a missing timezone instead of spending a real human approval", async () => {
    setDharahilEnabled(true);

    await expect(
      updateCalendarEvent(context, {
        eventId: "evt-1",
        startTime: "2026-09-02T14:00:00",
      }),
    ).rejects.toThrow("Timezone");

    expect(dharahilClient.runApprovalLoop).not.toHaveBeenCalled();
  });
});
