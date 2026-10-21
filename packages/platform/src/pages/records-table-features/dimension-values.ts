/**
 * How a date dimension value reads. A pivot axis and a grid grouping bucket dates the same way
 * (a calendar unit in the organisation's time zone), so both name a bucket and bound its days
 * through these helpers.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayText = (number: number): string => new Date(number * DAY_MS).toISOString().slice(0, 10);

/** The calendar day an instant falls on in a named time zone. */
const localDay = (instant: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(instant));

/**
 * The first calendar day of the bucket a date or date-and-time bucket value stands for: the
 * summary returns a date bucket as its first day, and a date-and-time bucket as the UTC instant
 * that opens it, which falls on that day in the organisation's time zone.
 */
export const bucketFirstDay = (
  fieldType: string,
  value: string,
  timeZone: string | undefined,
): string => (fieldType === "date_time" ? localDay(value, timeZone ?? "UTC") : value.slice(0, 10));

/** The last calendar day of the bucket that starts on `start`. */
export const bucketLastDay = (start: string, unit: string): string => {
  const date = new Date(`${start}T00:00:00Z`);
  const months = unit === "year" ? 12 : unit === "quarter" ? 3 : unit === "month" ? 1 : 0;
  if (months > 0) {
    date.setUTCMonth(date.getUTCMonth() + months);
    return dayText(Math.round(date.getTime() / DAY_MS) - 1);
  }
  return dayText(dayNumber(start) + (unit === "week" ? 6 : 0));
};

const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** The heading of a date bucket from the first calendar day it holds. */
export const bucketLabel = (start: string, unit: string): string => {
  const [year = "", month = "01", day = "01"] = start.split("-");
  const monthName = monthNames[Number(month) - 1] ?? month;
  switch (unit) {
    case "year":
      return year;
    case "quarter":
      return `Q${Math.floor((Number(month) - 1) / 3) + 1} ${year}`;
    case "month":
      return `${monthName} ${year}`;
    case "week":
      return `Week of ${Number(day)} ${monthName} ${year}`;
    default:
      return `${Number(day)} ${monthName} ${year}`;
  }
};
