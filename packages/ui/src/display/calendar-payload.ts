import { calendarPayloadSchema, type CalendarPayload } from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { fail } from "./payload-parse";
import { parseProjectedPart } from "./projected-data";

/**
 * The ready values a calendar block accepts: the platform calendar payload, in a time zone this
 * browser can show.
 */
export const parseCalendarPayload = (
  value: unknown,
  location: DefinitionRenderErrorLocation = {},
): CalendarPayload => {
  const calendar = parseProjectedPart(
    calendarPayloadSchema,
    value,
    "Projected calendar values are invalid",
    location,
  );
  try {
    new Intl.DateTimeFormat("en", { timeZone: calendar.timeZone }).format(0);
  } catch {
    return fail("A calendar time zone must be supported", location, ["timeZone"]);
  }
  return calendar;
};
