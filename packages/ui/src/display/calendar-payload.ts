import type { CalendarPayload } from "@vortex/platform/schema";
import type { DefinitionRenderErrorLocation } from "../definition-error";
import { fail } from "./payload-parse";

/**
 * The calendar payload the server built, in a time zone this browser can show: the one check the
 * server cannot make for the browser that renders it.
 */
export const checkCalendarPayload = (
  calendar: CalendarPayload,
  location: DefinitionRenderErrorLocation = {},
): CalendarPayload => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: calendar.timeZone }).format(0);
  } catch {
    return fail("A calendar time zone must be supported", location, ["timeZone"]);
  }
  return calendar;
};
