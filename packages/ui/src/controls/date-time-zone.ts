/**
 * Wall-clock conversion between a stored instant and a local date-time text in one IANA time zone.
 * Shared by the date-time input and the grid's cell editor so both read and write the same instant.
 */
type DateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

const DATE_TIME_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export const formatterFor = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

const partsAt = (instant: number, timeZone: string): DateTimeParts => {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
};

const inputText = (parts: DateTimeParts): string =>
  `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}`;

const utcMilliseconds = (parts: DateTimeParts): number => {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
};

const parseLocalParts = (raw: string): DateTimeParts | undefined => {
  const match = DATE_TIME_LOCAL.exec(raw);
  if (match === null) return undefined;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? "0"),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour > 23 ||
    parts.minute > 59 ||
    parts.second > 59
  )
    return undefined;
  const calendar = new Date(0);
  calendar.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  calendar.setUTCHours(0, 0, 0, 0);
  return calendar.getUTCFullYear() === parts.year &&
    calendar.getUTCMonth() === parts.month - 1 &&
    calendar.getUTCDate() === parts.day
    ? parts
    : undefined;
};

/** Formats one stored instant for the field's effective display time zone. */
export const toLocalInputValue = (value: string | null, timeZone: string): string => {
  if (value === null) return "";
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) return "";
  return inputText(partsAt(instant, timeZone));
};

/** Converts an unambiguous wall-clock input to an ISO instant. */
export const toStoredInstant = (raw: string, timeZone: string): string | undefined => {
  const local = parseLocalParts(raw);
  if (local === undefined) return undefined;
  const wallClock = utcMilliseconds(local);
  const offsets = new Set<number>();
  for (const probe of [
    wallClock - 36 * 60 * 60 * 1_000,
    wallClock,
    wallClock + 36 * 60 * 60 * 1_000,
  ]) {
    const zoned = partsAt(probe, timeZone);
    offsets.add(utcMilliseconds(zoned) - probe);
  }
  const matches = [...offsets]
    .map((offset) => wallClock - offset)
    .filter((candidate) => inputText(partsAt(candidate, timeZone)) === inputText(local));
  return matches.length === 1 ? new Date(matches[0]!).toISOString() : undefined;
};
