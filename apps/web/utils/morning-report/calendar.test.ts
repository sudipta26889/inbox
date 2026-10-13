import { describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));

const { mockFetchEvents } = vi.hoisted(() => ({ mockFetchEvents: vi.fn() }));
vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: vi
    .fn()
    .mockResolvedValue([{ fetchEvents: mockFetchEvents }]),
}));

import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
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

    const { events, failed } = await fetchTodayEvents({
      emailAccountId: "ea",
      timeZone: "Asia/Calcutta",
      now,
      logger,
    });
    expect(failed).toBe(false);

    expect(mockFetchEvents).toHaveBeenCalledWith({
      timeMin: now,
      timeMax: new Date("2026-10-13T18:29:59.999Z"), // 23:59:59.999 IST
      maxResults: 50,
    });
    expect(events.map((e) => e.id)).toEqual(["2"]);
  });

  it("keeps events from healthy providers and logs the failed one", async () => {
    const rejecting = vi.fn().mockRejectedValue(new Error("invalid_grant"));
    const resolving = vi.fn().mockResolvedValue({
      nextPageToken: null,
      events: [
        {
          id: "ok",
          title: "Design review",
          startTime: new Date("2026-10-13T10:00:00Z"),
          endTime: new Date("2026-10-13T11:00:00Z"),
          attendees: [],
        },
      ],
    });
    vi.mocked(createCalendarEventProviders).mockResolvedValueOnce([
      { fetchEvents: rejecting },
      { fetchEvents: resolving },
    ] as never);
    const warn = vi.spyOn(logger, "warn");

    const { events, failed } = await fetchTodayEvents({
      emailAccountId: "ea",
      timeZone: "Asia/Calcutta",
      now: new Date("2026-10-13T03:30:00Z"),
      logger,
    });

    expect(failed).toBe(true);
    expect(events.map((e) => e.id)).toEqual(["ok"]);
    expect(warn).toHaveBeenCalledWith("Morning report calendar fetch failed", {
      error: expect.any(Error),
    });
  });
});
