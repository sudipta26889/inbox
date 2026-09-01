import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { GoogleCalendarEventProvider } from "./google-events";

vi.mock("server-only", () => ({}));

const client = {
  events: {
    insert: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    instances: vi.fn(),
    list: vi.fn(),
  },
  calendarList: { list: vi.fn() },
};

vi.mock("@/utils/calendar/client", () => ({
  getCalendarClientWithRefresh: async () => client,
}));

function makeProvider() {
  return new GoogleCalendarEventProvider(
    {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
      emailAccountId: "acct-1",
    },
    createScopedLogger("test"),
  );
}

describe("GoogleCalendarEventProvider.createEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.events.insert.mockResolvedValue({
      data: {
        id: "evt-1",
        summary: "Sync",
        start: { dateTime: "2026-09-02T14:00:00+05:30" },
        end: { dateTime: "2026-09-02T15:00:00+05:30" },
        htmlLink: "https://calendar.google.com/x",
      },
    });
  });

  it("passes the caller's timezone through instead of forcing UTC", async () => {
    await makeProvider().createEvent(
      {
        title: "Sync",
        start: { dateTime: "2026-09-02T14:00:00", timeZone: "Asia/Kolkata" },
        end: { dateTime: "2026-09-02T15:00:00", timeZone: "Asia/Kolkata" },
      },
      { notify: "all" },
    );

    const body = client.events.insert.mock.calls[0][0].requestBody;
    expect(body.start).toEqual({
      dateTime: "2026-09-02T14:00:00",
      timeZone: "Asia/Kolkata",
    });
    expect(body.end.timeZone).toBe("Asia/Kolkata");
  });

  it("sends sendUpdates explicitly, never relying on the API default", async () => {
    await makeProvider().createEvent(
      {
        title: "Sync",
        start: { date: "2026-09-02" },
        end: { date: "2026-09-03" },
      },
      { notify: "external" },
    );

    expect(client.events.insert.mock.calls[0][0].sendUpdates).toBe(
      "externalOnly",
    );
    expect(
      client.events.insert.mock.calls[0][0].sendNotifications,
    ).toBeUndefined();
  });

  it("uses the idempotency key as the event id so retries do not duplicate", async () => {
    await makeProvider().createEvent(
      {
        title: "Sync",
        start: { date: "2026-09-02" },
        end: { date: "2026-09-03" },
      },
      { notify: "none", idempotencyKey: "abc12" },
    );

    expect(client.events.insert.mock.calls[0][0].requestBody.id).toBe("abc12");
  });

  it("rejects an idempotency key Google will not accept", async () => {
    await expect(
      makeProvider().createEvent(
        {
          title: "Sync",
          start: { date: "2026-09-02" },
          end: { date: "2026-09-03" },
        },
        { notify: "none", idempotencyKey: "UPPER-case!" },
      ),
    ).rejects.toThrow("idempotencyKey");
  });

  it("carries the Meet link through when the API response includes one", async () => {
    client.events.insert.mockResolvedValueOnce({
      data: {
        id: "evt-1",
        summary: "Sync",
        start: { dateTime: "2026-09-02T14:00:00+05:30" },
        end: { dateTime: "2026-09-02T15:00:00+05:30" },
        htmlLink: "https://calendar.google.com/x",
        hangoutLink: "https://meet.google.com/abc-defg-hij",
      },
    });

    const event = await makeProvider().createEvent(
      {
        title: "Sync",
        start: { dateTime: "2026-09-02T14:00:00", timeZone: "Asia/Kolkata" },
        end: { dateTime: "2026-09-02T15:00:00", timeZone: "Asia/Kolkata" },
      },
      { notify: "all" },
    );

    expect(event.videoConferenceLink).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
  });
});

describe("GoogleCalendarEventProvider.deleteEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cancels a single occurrence rather than the whole series", async () => {
    client.events.patch.mockResolvedValue({ data: {} });

    await makeProvider().deleteEvent("evt-1_20260902T083000Z", {
      notify: "none",
      scope: "this",
    });

    expect(client.events.delete).not.toHaveBeenCalled();
    expect(client.events.patch.mock.calls[0][0].requestBody.status).toBe(
      "cancelled",
    );
  });

  it("rejects scope 'this' with a master id instead of cancelling the whole series", async () => {
    // A master id passed with scope 'this' would have Google cancel every
    // occurrence, not just one — the approval prompt promises "one
    // occurrence", so this must fail loudly rather than silently comply.
    await expect(
      makeProvider().deleteEvent("evt-1", { notify: "none", scope: "this" }),
    ).rejects.toThrow("per-occurrence eventId");

    expect(client.events.patch).not.toHaveBeenCalled();
    expect(client.events.delete).not.toHaveBeenCalled();
  });

  it("deletes the series when scope is all", async () => {
    client.events.delete.mockResolvedValue({ data: {} });

    await makeProvider().deleteEvent("evt-1", { notify: "all", scope: "all" });

    expect(client.events.delete).toHaveBeenCalled();
    expect(client.events.delete.mock.calls[0][0].sendUpdates).toBe("all");
  });

  it("rejects thisAndFollowing instead of deleting the whole series", async () => {
    // Google has no single-call "this and following" delete. Falling through
    // to events.delete would destroy every past occurrence too.
    await expect(
      makeProvider().deleteEvent("evt-1", {
        notify: "none",
        scope: "thisAndFollowing",
      }),
    ).rejects.toThrow("thisAndFollowing");

    expect(client.events.delete).not.toHaveBeenCalled();
    expect(client.events.patch).not.toHaveBeenCalled();
  });
});

describe("GoogleCalendarEventProvider.changeAttendees", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not uninvite the attendees it was not told about", async () => {
    // events.patch overwrites array fields wholesale. A naive implementation
    // that writes only the added attendee silently removes everyone else.
    client.events.get.mockResolvedValue({
      data: {
        attendees: [
          { email: "keep@x.com", responseStatus: "accepted" },
          { email: "drop@x.com", responseStatus: "needsAction" },
        ],
      },
    });
    client.events.patch.mockResolvedValue({ data: { id: "evt-1" } });

    await makeProvider().changeAttendees(
      "evt-1",
      { add: ["new@x.com"], remove: ["drop@x.com"] },
      { notify: "none" },
    );

    const sent = client.events.patch.mock.calls[0][0].requestBody.attendees;
    expect(sent).toEqual([
      { email: "keep@x.com", responseStatus: "accepted" },
      { email: "new@x.com" },
    ]);
  });

  it("does not duplicate an attendee who is already invited", async () => {
    client.events.get.mockResolvedValue({
      data: {
        attendees: [{ email: "Keep@x.com", responseStatus: "accepted" }],
      },
    });
    client.events.patch.mockResolvedValue({ data: { id: "evt-1" } });

    await makeProvider().changeAttendees(
      "evt-1",
      { add: ["keep@x.com"] },
      { notify: "none" },
    );

    expect(
      client.events.patch.mock.calls[0][0].requestBody.attendees,
    ).toHaveLength(1);
  });
});

describe("GoogleCalendarEventProvider.updateEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes a wall-clock start time through byte-identical, never through a Date", async () => {
    client.events.patch.mockResolvedValue({
      data: {
        id: "evt-1",
        summary: "Sync",
        start: { dateTime: "2026-09-02T14:00:00", timeZone: "Asia/Kolkata" },
        end: { dateTime: "2026-09-02T15:00:00", timeZone: "Asia/Kolkata" },
      },
    });

    await makeProvider().updateEvent(
      "evt-1",
      { start: { dateTime: "2026-09-02T14:00:00", timeZone: "Asia/Kolkata" } },
      { notify: "none" },
    );

    expect(client.events.patch.mock.calls[0][0].requestBody.start).toEqual({
      dateTime: "2026-09-02T14:00:00",
      timeZone: "Asia/Kolkata",
    });
  });

  it("rejects thisAndFollowing instead of patching the whole series", async () => {
    // Same hazard as deleteEvent: patching a series master with scope
    // 'thisAndFollowing' would rewrite every occurrence, past included.
    await expect(
      makeProvider().updateEvent(
        "evt-1",
        {
          start: { dateTime: "2026-09-02T14:00:00", timeZone: "Asia/Kolkata" },
        },
        { notify: "none", scope: "thisAndFollowing" },
      ),
    ).rejects.toThrow("thisAndFollowing");

    expect(client.events.patch).not.toHaveBeenCalled();
  });
});

describe("GoogleCalendarEventProvider.respondToEvent", () => {
  beforeEach(() => vi.clearAllMocks());

  it("patches only the caller's own attendee row, keeping every other guest invited", async () => {
    // A regression to "patch only my own attendee object" (dropping the
    // rest) would silently uninvite every other guest on events.patch's
    // whole-array write.
    client.events.get.mockResolvedValue({
      data: {
        attendees: [
          { email: "organizer@x.com", responseStatus: "needsAction" },
          { email: "me@x.com", self: true, responseStatus: "needsAction" },
          { email: "other@x.com", responseStatus: "tentative" },
        ],
      },
    });
    client.events.patch.mockResolvedValue({ data: {} });

    await makeProvider().respondToEvent("evt-1", {
      responseStatus: "accepted",
    });

    const sent = client.events.patch.mock.calls[0][0].requestBody.attendees;
    expect(sent).toEqual([
      { email: "organizer@x.com", responseStatus: "needsAction" },
      {
        email: "me@x.com",
        self: true,
        responseStatus: "accepted",
        comment: undefined,
      },
      { email: "other@x.com", responseStatus: "tentative" },
    ]);
  });

  it("keeps a previously-set RSVP comment when no new comment is given", async () => {
    // An unconditional `comment: options.comment` write would wipe a prior
    // comment any time the caller only changes the responseStatus.
    client.events.get.mockResolvedValue({
      data: {
        attendees: [
          {
            email: "me@x.com",
            self: true,
            responseStatus: "tentative",
            comment: "running late",
          },
        ],
      },
    });
    client.events.patch.mockResolvedValue({ data: {} });

    await makeProvider().respondToEvent("evt-1", {
      responseStatus: "accepted",
    });

    const sent = client.events.patch.mock.calls[0][0].requestBody.attendees;
    expect(sent).toEqual([
      {
        email: "me@x.com",
        self: true,
        responseStatus: "accepted",
        comment: "running late",
      },
    ]);
  });
});

describe("GoogleCalendarEventProvider.listEventInstances", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes eventId and the time bounds through and maps the returned items", async () => {
    client.events.instances.mockResolvedValue({
      data: {
        items: [
          {
            id: "evt-1_20260902T083000Z",
            summary: "Sync",
            start: { dateTime: "2026-09-02T14:00:00+05:30" },
            end: { dateTime: "2026-09-02T15:00:00+05:30" },
            recurringEventId: "evt-1",
          },
        ],
      },
    });

    const result = await makeProvider().listEventInstances("evt-1", {
      timeMin: "2026-09-01T00:00:00Z",
      timeMax: "2026-09-30T00:00:00Z",
    });

    expect(client.events.instances.mock.calls[0][0]).toMatchObject({
      eventId: "evt-1",
      timeMin: "2026-09-01T00:00:00Z",
      timeMax: "2026-09-30T00:00:00Z",
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "evt-1_20260902T083000Z",
      title: "Sync",
      recurringEventId: "evt-1",
    });
  });
});

describe("GoogleCalendarEventProvider.fetchEvents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("maps query, maxResults and pageToken onto the Google API call", async () => {
    client.events.list.mockResolvedValue({
      data: { items: [], nextPageToken: null },
    });

    await makeProvider().fetchEvents({
      query: "standup",
      maxResults: 10,
      pageToken: "tok-1",
    });

    expect(client.events.list.mock.calls[0][0]).toMatchObject({
      q: "standup",
      maxResults: 10,
      pageToken: "tok-1",
      singleEvents: true,
      orderBy: "startTime",
    });
  });

  it("returns nextPageToken from the API response", async () => {
    client.events.list.mockResolvedValue({
      data: { items: [], nextPageToken: "tok-2" },
    });

    const result = await makeProvider().fetchEvents({});

    expect(result.nextPageToken).toBe("tok-2");
  });

  it("returns null nextPageToken when the API omits one", async () => {
    client.events.list.mockResolvedValue({ data: { items: [] } });

    const result = await makeProvider().fetchEvents({});

    expect(result.nextPageToken).toBeNull();
  });
});

describe("GoogleCalendarEventProvider.listCalendars", () => {
  it("surfaces primary and accessRole so the model can predict write failures", async () => {
    vi.clearAllMocks();
    client.calendarList.list.mockResolvedValue({
      data: {
        items: [
          {
            id: "primary-id",
            summary: "Me",
            timeZone: "Asia/Kolkata",
            primary: true,
            accessRole: "owner",
          },
          {
            id: "ro-id",
            summary: "Holidays",
            timeZone: "UTC",
            accessRole: "reader",
          },
        ],
      },
    });

    const calendars = await makeProvider().listCalendars();

    expect(calendars).toEqual([
      {
        id: "primary-id",
        summary: "Me",
        timeZone: "Asia/Kolkata",
        primary: true,
        accessRole: "owner",
      },
      {
        id: "ro-id",
        summary: "Holidays",
        timeZone: "UTC",
        primary: false,
        accessRole: "reader",
      },
    ]);
  });
});
