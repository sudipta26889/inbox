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

  it("deletes the series when scope is all", async () => {
    client.events.delete.mockResolvedValue({ data: {} });

    await makeProvider().deleteEvent("evt-1", { notify: "all", scope: "all" });

    expect(client.events.delete).toHaveBeenCalled();
    expect(client.events.delete.mock.calls[0][0].sendUpdates).toBe("all");
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
