import { describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));

const { mockFetchEvents } = vi.hoisted(() => ({ mockFetchEvents: vi.fn() }));
vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: vi
    .fn()
    .mockResolvedValue([{ fetchEvents: mockFetchEvents }]),
}));

import { fetchTodayEvents } from "./calendar";

const logger = createScopedLogger("test");

describe("fetchTodayEvents", () => {
  it("asks for now until local midnight and drops cancelled events", async () => {
    mockFetchEvents.mockResolvedValue({
      nextPageToken: null,
      events: [
        {
          id: "2",
          title: "Producer AI Copilot Pt.2",
          startTime: new Date("2026-10-13T10:00:00Z"),
          endTime: new Date("2026-10-13T11:00:00Z"),
          attendees: [],
        },
        {
          id: "1",
          title: "Cancelled: Standup",
          startTime: new Date("2026-10-13T05:00:00Z"),
          endTime: new Date("2026-10-13T05:30:00Z"),
          attendees: [],
        },
      ],
    });
    const now = new Date("2026-10-13T03:30:00Z"); // 09:00 IST

    const events = await fetchTodayEvents({
      emailAccountId: "ea",
      timeZone: "Asia/Calcutta",
      now,
      logger,
    });

    expect(mockFetchEvents).toHaveBeenCalledWith({
      timeMin: now,
      timeMax: new Date("2026-10-13T18:29:59.999Z"), // 23:59:59.999 IST
      maxResults: 50,
    });
    expect(events.map((e) => e.id)).toEqual(["2"]);
  });
});
