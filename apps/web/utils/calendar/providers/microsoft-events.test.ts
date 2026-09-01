import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { MicrosoftCalendarEventProvider } from "./microsoft-events";

vi.mock("server-only", () => ({}));

const api = {
  query: vi.fn().mockReturnThis(),
  top: vi.fn().mockReturnThis(),
  orderby: vi.fn().mockReturnThis(),
  get: vi.fn(),
};
const client = { api: vi.fn(() => api) };

vi.mock("@/utils/outlook/calendar-client", () => ({
  getCalendarClientWithRefresh: async () => client,
}));

function makeProvider() {
  return new MicrosoftCalendarEventProvider(
    {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: null,
      emailAccountId: "acct-1",
    },
    createScopedLogger("test"),
  );
}

describe("MicrosoftCalendarEventProvider.fetchEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.query.mockReturnThis();
    api.top.mockReturnThis();
    api.orderby.mockReturnThis();
  });

  it("filters client-side on a query instead of returning every event in range", async () => {
    // calendarView has no server-side free-text search, unlike Google's `q`.
    // Before this fix, `query` was accepted but never applied, so every
    // event in the date range came back presented as a "match".
    api.get.mockResolvedValue({
      value: [
        { id: "1", subject: "Daily standup" },
        { id: "2", subject: "1:1 with manager" },
        { id: "3", subject: "Unrelated", bodyPreview: "standup notes here" },
      ],
    });

    const result = await makeProvider().fetchEvents({ query: "standup" });

    expect(result.events.map((e) => e.id)).toEqual(["1", "3"]);
  });

  it("matches case-insensitively and against location too", async () => {
    api.get.mockResolvedValue({
      value: [
        {
          id: "1",
          subject: "Planning",
          location: { displayName: "STANDUP room" },
        },
        { id: "2", subject: "Other" },
      ],
    });

    const result = await makeProvider().fetchEvents({ query: "Standup" });

    expect(result.events.map((e) => e.id)).toEqual(["1"]);
  });

  it("matches an attendee's email, since Google's server-side q does too", async () => {
    api.get.mockResolvedValue({
      value: [
        {
          id: "1",
          subject: "Planning",
          attendees: [
            { emailAddress: { address: "alice@example.com", name: "Alice" } },
          ],
        },
        { id: "2", subject: "Other" },
      ],
    });

    const result = await makeProvider().fetchEvents({
      query: "alice@example.com",
    });

    expect(result.events.map((e) => e.id)).toEqual(["1"]);
  });

  it("returns every event when no query is given", async () => {
    api.get.mockResolvedValue({
      value: [
        { id: "1", subject: "A" },
        { id: "2", subject: "B" },
      ],
    });

    const result = await makeProvider().fetchEvents({});

    expect(result.events).toHaveLength(2);
  });
});
