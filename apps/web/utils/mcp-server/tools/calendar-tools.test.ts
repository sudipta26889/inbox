import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCalendarEvent, searchCalendar } from "./calendar-tools";
import type { McpToolContext } from "./registry";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_DHARAHIL_ENABLED: false } }));

const provider = {
  createEvent: vi.fn(),
  fetchEvents: vi.fn(),
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
