import { Temporal } from "@js-temporal/polyfill";
import { flowInstantMicros } from "../rules/flow-instant";

/** An endpoint cannot be expressed by the shared four-digit-year instant contract. */
export class CalendarEndpointError extends RangeError {
  constructor() {
    super("Choose a calendar range whose endpoints have UTC years from 0000 to 9999");
    this.name = "CalendarEndpointError";
  }
}

export const calendarAddDays = (date: string, count: number): string =>
  Temporal.PlainDate.from(date).add({ days: count }).toString();

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
