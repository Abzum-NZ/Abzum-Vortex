import { timestampSchema } from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import {
  fail,
  requireRecord,
  requireExactKeys,
  requireNonEmptyString,
  requireString,
  requireArray,
} from "./payload-parse";
import type { CalendarPayload } from "./projected-data";
const ISO_CALENDAR_DATE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const isValidIsoCalendarDate = (text: string): boolean => {
  if (!ISO_CALENDAR_DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

/** The ready values a calendar block accepts. */
export const parseCalendarPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): CalendarPayload => {
  const record = requireRecord(value, "Projected display values must be an object", location);
  if (record.kind !== "calendar")
    return fail(`Expected 'calendar' projected values, got '${String(record.kind)}'`, location);
  requireExactKeys(
    record,
    [
      "kind",
      "view",
      "date",
      "windowStart",
      "windowEnd",
      "timeZone",
      "endExclusive",
      "truncated",
      "items",
    ],
    location,
  );
  const calendarDate = (candidate: unknown, message: string): string => {
    const text = requireNonEmptyString(candidate, message, location);
    if (!isValidIsoCalendarDate(text)) return fail(message, location);
    return text;
  };
  const dateOrTimestamp = (candidate: unknown, message: string): string => {
    const text = requireNonEmptyString(candidate, message, location);
    const date = isValidIsoCalendarDate(text);
    if (!date && !timestampSchema.safeParse(text).success) return fail(message, location);
    return text;
  };
  const view = record.view;
  if (view !== "month" && view !== "week" && view !== "agenda")
    return fail("A calendar view must be month, week or agenda", location);
  const date = calendarDate(record.date, "A calendar requires an ISO date");
  const windowStart = calendarDate(record.windowStart, "A calendar requires a window start date");
  const windowEnd = calendarDate(record.windowEnd, "A calendar requires a window end date");
  if (windowStart >= windowEnd)
    return fail("A calendar window must have positive length", location);
  const timeZone = requireNonEmptyString(
    record.timeZone,
    "A calendar requires a time zone",
    location,
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0);
  } catch {
    return fail("A calendar time zone must be supported", location);
  }
  if (typeof record.truncated !== "boolean")
    return fail("A calendar requires a truncation flag", location);
  if (typeof record.endExclusive !== "boolean")
    return fail("A calendar requires an end boundary rule", location);
  const seen = new Set<string>();
  const items = requireArray(record.items, "Calendar items must be an array", location).map(
    (candidate): CalendarPayload["items"][number] => {
      const item = requireRecord(candidate, "A calendar item must be an object", location);
      requireExactKeys(item, ["recordId", "start", "end", "title"], location);
      const recordId = requireNonEmptyString(
        item.recordId,
        "A calendar item requires a record identity",
        location,
      );
      const normalizedRecordId = recordId.toLowerCase();
      if (seen.has(normalizedRecordId)) fail("Each calendar record appears once", location);
      seen.add(normalizedRecordId);
      const start = dateOrTimestamp(item.start, "A calendar item requires a valid start");
      const end =
        item.end === null ? null : dateOrTimestamp(item.end, "A calendar item end must be valid");
      if (end !== null && isValidIsoCalendarDate(start) !== isValidIsoCalendarDate(end))
        fail("A calendar item start and end must use the same date precision", location);
      return Object.freeze({
        recordId,
        start,
        end,
        title: requireString(item.title, "A calendar item requires a title", location),
      });
    },
  );
  return Object.freeze({
    kind: "calendar",
    view,
    date,
    windowStart,
    windowEnd,
    timeZone,
    endExclusive: record.endExclusive,
    truncated: record.truncated,
    items: Object.freeze(items),
  });
};
