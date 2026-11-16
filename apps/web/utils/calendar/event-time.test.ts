import { describe, it, expect } from "vitest";
import { toEventTime, allDayEndDate, toSendUpdates } from "./event-time";

describe("toEventTime", () => {
  it("pairs a naive wall-clock time with the resolved zone", () => {
    expect(toEventTime("2026-09-02T14:00:00", "Asia/Kolkata")).toEqual({
      dateTime: "2026-09-02T14:00:00",
      timeZone: "Asia/Kolkata",
    });
  });

  it("keeps an explicit offset verbatim rather than reinterpreting it", () => {
    expect(
      toEventTime("2026-09-02T14:00:00+05:30", "America/New_York"),
    ).toEqual({
      dateTime: "2026-09-02T14:00:00+05:30",
      timeZone: "America/New_York",
    });
  });

  it("treats a bare date as all-day and drops the zone", () => {
    expect(toEventTime("2026-09-02", "Asia/Kolkata")).toEqual({
      date: "2026-09-02",
    });
  });

  it("never routes a wall-clock time through a Date", () => {
    // Regression guard: a Date round-trip in Asia/Kolkata would emit 08:30Z.
    const result = toEventTime("2026-09-02T14:00:00", "Asia/Kolkata");
    expect((result as { dateTime: string }).dateTime).not.toMatch(/Z$/);
    expect(JSON.stringify(result)).not.toContain("08:30");
  });

  it("rejects an empty zone rather than defaulting to UTC", () => {
    expect(() => toEventTime("2026-09-02T14:00:00", "")).toThrow(
      "Timezone could not be resolved",
    );
  });
});

describe("allDayEndDate", () => {
  it("makes the end exclusive, as Google requires", () => {
    expect(allDayEndDate("2026-09-02")).toBe("2026-09-03");
  });

  it("rolls over a month boundary", () => {
    expect(allDayEndDate("2026-09-30")).toBe("2026-10-01");
  });

  it("rolls over a leap day", () => {
    expect(allDayEndDate("2028-02-28")).toBe("2028-02-29");
  });
});

describe("toSendUpdates", () => {
  it("maps our levels onto the Google enum", () => {
    expect(toSendUpdates("all")).toBe("all");
    expect(toSendUpdates("external")).toBe("externalOnly");
    expect(toSendUpdates("none")).toBe("none");
  });
});
