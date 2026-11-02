import { zonedDateTimeParts } from "@vortex/platform/schema";

/** The page clock and the same instant's calendar date in the organisation's time zone. */
export const pageFlowClock = (
  timeZone: string,
): Readonly<{
  now: string;
  organizationLocalDate: string;
}> => {
  const instant = new Date();
  const parts = zonedDateTimeParts(instant, timeZone);
  if (!Number.isFinite(parts.year) || !Number.isFinite(parts.month) || !Number.isFinite(parts.day))
    throw new Error("FLOW_ORGANIZATION_LOCAL_DATE_UNAVAILABLE");
  return {
    now: instant.toISOString(),
    organizationLocalDate: `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`,
  };
};
