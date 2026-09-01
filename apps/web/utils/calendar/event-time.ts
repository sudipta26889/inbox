export type EventTime =
  | { dateTime: string; timeZone: string }
  | { date: string };

export type NotifyLevel = "all" | "external" | "none";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Build a calendar time payload from an agent-supplied string.
 *
 * The string is passed through untouched. Parsing a wall-clock time into a
 * `Date` and re-serialising it is what silently shifts events by hours — a
 * `Date` cannot represent "2pm in Kolkata", only an instant.
 */
export function toEventTime(input: string, timeZone: string): EventTime {
  if (DATE_ONLY.test(input)) return { date: input };

  if (!timeZone) {
    throw new Error(
      "Timezone could not be resolved for this event. Pass timeZone as an IANA name (e.g. 'Asia/Kolkata').",
    );
  }

  return { dateTime: input, timeZone };
}

/**
 * Google treats an all-day event's end date as exclusive, so a one-day event
 * on the 2nd ends on the 3rd. Callers give us the last day they mean.
 */
export function allDayEndDate(lastDay: string): string {
  if (!DATE_ONLY.test(lastDay)) {
    throw new Error(`Expected a YYYY-MM-DD date, got "${lastDay}"`);
  }

  // Date is safe here: this is a pure calendar-date increment at UTC midnight,
  // with no wall-clock or zone semantics to lose.
  const next = new Date(`${lastDay}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export function toSendUpdates(
  notify: NotifyLevel,
): "all" | "externalOnly" | "none" {
  if (notify === "external") return "externalOnly";
  return notify;
}
