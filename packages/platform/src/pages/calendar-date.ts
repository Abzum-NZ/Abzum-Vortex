import { Temporal } from "@js-temporal/polyfill";
import { flowInstantMicros } from "../rules/flow-instant";

/** An endpoint cannot be expressed by the shared four-digit-year instant contract. */
export class CalendarEndpointError extends RangeError {
  constructor() {
    super("Choose a calendar range whose endpoints have UTC years from 0000 to 9999");
    this.name = "CalendarEndpointError";
  }
}

/** A real ISO calendar date with a four-digit year from 0001 to 9999. */
export const calendarDateIsValid = (candidate: string | undefined): candidate is string => {
  if (candidate === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  try {
    const date = Temporal.PlainDate.from(candidate, { overflow: "reject" });
    return date.year >= 1 && date.year <= 9999;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};

export const calendarAddDays = (date: string, count: number): string =>
  Temporal.PlainDate.from(date).add({ days: count }).toString();

/** The same day in another month, kept within that month's last day. */
export const calendarShiftMonth = (date: string, count: number): string =>
  Temporal.PlainDate.from(date).add({ months: count }).toString();

export const calendarMonthStart = (date: string): string =>
  Temporal.PlainDate.from(date).with({ day: 1 }).toString();

export const calendarDaysInMonth = (date: string): number =>
  Temporal.PlainDate.from(date).daysInMonth;

/** Days since the Monday that starts the date's week: 0 for Monday through 6 for Sunday. */
export const calendarDaysSinceMonday = (date: string): number =>
  Temporal.PlainDate.from(date).dayOfWeek - 1;

export const calendarLocalDate = (instant: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(instant)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();

/**
 * First instant of a local ISO day, including skipped/repeated midnight and era changes.
 * Extended local years may describe a boundary, but its UTC instant must remain in the
 * four-digit-year domain accepted by flowInstantMicros. Never clamp an exclusive endpoint.
 */
export const calendarStartOfDay = (date: string, timeZone: string): string => {
  const instant = Temporal.PlainDate.from(date).toZonedDateTime(timeZone).toInstant().toString();
  if (flowInstantMicros(instant) === undefined) throw new CalendarEndpointError();
  return instant;
};
