/**
 * Organisation or viewer presentation settings for dates. The host passes the locale (a BCP 47
 * tag) and IANA time zone; when it passes none, the viewer's own browser settings apply after
 * mount, so server and first client output stay identical.
 */
export type DateFormatOptions = Readonly<{
  locale?: string | undefined;
  timeZone?: string | undefined;
}>;

/** Fixed fallbacks for server output and for a host that supplies none, identical on both sides. */
const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIME_ZONE = "UTC";

/** Shown wherever a stored date or timestamp cannot be read. */
export const INVALID_DATE_TEXT = "Invalid date value";

const DATE_PARTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const DATE_TIME_PARTS: Intl.DateTimeFormatOptions = {
  ...DATE_PARTS,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
};
const FULL_PARTS: Intl.DateTimeFormatOptions = {
  ...DATE_PARTS,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
};
const TIME_PARTS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const WEEKDAY_PARTS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
};
const MONTH_PARTS: Intl.DateTimeFormatOptions = { month: "long", year: "numeric" };
const SHORT_MONTH_PARTS: Intl.DateTimeFormatOptions = { month: "short" };
const CALENDAR_DAY_PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
};
const INPUT_PARTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};
type DateFormatStyle =
  "auto" | "full" | "time" | "weekday" | "month" | "shortMonth" | "calendarDay" | "input";
const MAXIMUM_CACHED_FORMATTERS = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** A number rendered with the same explicit locale fallback as dates. */
export function formatLocaleNumber(value: number, locale = DEFAULT_LOCALE): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return new Intl.NumberFormat(DEFAULT_LOCALE).format(value);
  }
}

/** A whole count rendered with the same explicit locale fallback as dates. */
export function formatCount(value: number, options: DateFormatOptions = {}): string {
  return formatLocaleNumber(value, options.locale ?? DEFAULT_LOCALE);
}

/** The one record-count sentence: "1 record" or "1,234 records". */
export function recordsPhrase(count: number, options: DateFormatOptions = {}): string {
  return count === 1 ? "1 record" : `${formatCount(count, options)} records`;
}

/** The one byte-size sentence: B, KB, MB, GB or TB, grouped in the fallback locale. */
export function formatBytes(bytes: number, options: DateFormatOptions = {}): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  if (bytes < 1024) return `${formatCount(Math.round(bytes), options)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${formatLocaleNumber(Number(rounded), options.locale ?? DEFAULT_LOCALE)} ${units[unit]}`;
}

/** Throws for an unsupported IANA time zone, so a malformed zone never becomes UTC silently. */
export function assertTimeZone(timeZone: string): void {
  new Intl.DateTimeFormat(DEFAULT_LOCALE, { timeZone });
}

/** One instant's wall-clock parts in an IANA time zone, from the one cached formatter. */
export type ZonedDateTimeParts = Readonly<{
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}>;

export function zonedDateTimeParts(
  instant: Date | number,
  timeZone: string | undefined,
): ZonedDateTimeParts {
  const formatter = formatterFor(INPUT_PARTS, DEFAULT_LOCALE, timeZone ?? DEFAULT_TIME_ZONE);
  const parts = formatter.formatToParts(typeof instant === "number" ? new Date(instant) : instant);
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
}

/** One cached formatter; an unsupported locale or time zone uses the fixed fallbacks. */
const formatterFor = (
  parts: Intl.DateTimeFormatOptions,
  locale: string,
  timeZone: string,
): Intl.DateTimeFormat => {
  const key = `${JSON.stringify(parts)}\u0000${locale}\u0000${timeZone}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { ...parts, timeZone });
  } catch {
    formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...parts, timeZone: DEFAULT_TIME_ZONE });
  }
  if (formatters.size >= MAXIMUM_CACHED_FORMATTERS) formatters.clear();
  formatters.set(key, formatter);
  return formatter;
};

const isCalendarDate = (iso: string): boolean => iso.length === 10;

/**
 * Formats a validated ISO calendar date or offset timestamp for presentation in the given locale
 * and time zone, for example `17 Sep 2026, 12:15`. A calendar date carries no time zone, so it is
 * formatted in UTC to avoid shifting its day and shows no time; a timestamp shows its day and
 * time in the viewer's time zone. Returns undefined when the value cannot be parsed.
 */
export function formatIsoDate(
  iso: string,
  options: DateFormatOptions = {},
  style: DateFormatStyle = "auto",
): string | undefined {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return undefined;
  const locale = options.locale ?? DEFAULT_LOCALE;
  const calendarDate = isCalendarDate(iso);
  const timeZone = calendarDate ? "UTC" : (options.timeZone ?? DEFAULT_TIME_ZONE);
  const parts =
    style === "input"
      ? INPUT_PARTS
      : style === "full"
        ? FULL_PARTS
        : style === "time"
          ? TIME_PARTS
          : style === "weekday"
            ? WEEKDAY_PARTS
            : style === "month"
              ? MONTH_PARTS
              : style === "shortMonth"
                ? SHORT_MONTH_PARTS
                : style === "calendarDay"
                  ? CALENDAR_DAY_PARTS
                  : calendarDate
                    ? DATE_PARTS
                    : DATE_TIME_PARTS;
  const formatter = formatterFor(parts, locale, timeZone);
  if (style === "input") {
    const values = new Map(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
    );
    return `${values.get("year")}-${values.get("month")}-${values.get("day")}T${values.get("hour")}:${values.get("minute")}:${values.get("second")}`;
  }
  return formatter.format(new Date(timestamp));
}

/** The full timestamp with seconds and time zone, for a hover title; undefined for a calendar date. */
export function formatIsoDateTitle(
  iso: string,
  options: DateFormatOptions = {},
): string | undefined {
  return isCalendarDate(iso) ? undefined : formatIsoDate(iso, options, "full");
}
