/** The page clock and the same instant's calendar date in the organisation's time zone. */
export const pageFlowClock = (
  timeZone: string,
): Readonly<{
  now: string;
  organizationLocalDate: string;
}> => {
  const instant = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (year === undefined || month === undefined || day === undefined)
    throw new Error("FLOW_ORGANIZATION_LOCAL_DATE_UNAVAILABLE");
  return { now: instant.toISOString(), organizationLocalDate: `${year}-${month}-${day}` };
};
