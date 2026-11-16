import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getLocalDate, getLocalHour } from "./daily-digest";

const IST = "Asia/Calcutta";

describe("getLocalHour / getLocalDate", () => {
  // 23:30 UTC is 05:00 the NEXT day in IST (UTC+5:30). The digest must key
  // and fire on the IST day, not the UTC one.
  it("maps 23:30 UTC to 5am on the next IST day", () => {
    const at2330Utc = new Date("2026-09-06T23:30:00.000Z");

    expect(getLocalHour(IST, at2330Utc)).toBe(5);
    expect(getLocalDate(IST, at2330Utc)).toBe("2026-09-07");
    expect(getLocalHour("UTC", at2330Utc)).toBe(23);
    expect(getLocalDate("UTC", at2330Utc)).toBe("2026-09-06");
  });

  it("does not fire outside the target hour", () => {
    expect(getLocalHour(IST, new Date("2026-09-06T22:59:00.000Z"))).toBe(4);
    expect(getLocalHour(IST, new Date("2026-09-07T00:30:00.000Z"))).toBe(6);
  });

  it("reports midnight as hour 0, not 24", () => {
    expect(getLocalHour(IST, new Date("2026-09-06T18:30:00.000Z"))).toBe(0);
  });
});
