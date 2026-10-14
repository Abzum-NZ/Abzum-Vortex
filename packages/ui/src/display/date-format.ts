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
const MAXIMUM_CACHED_FORMATTERS = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

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
export function formatIsoDate(iso: string, options: DateFormatOptions = {}): string | undefined {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return undefined;
  const locale = options.locale ?? DEFAULT_LOCALE;
  const calendarDate = isCalendarDate(iso);
  const timeZone = calendarDate ? "UTC" : (options.timeZone ?? DEFAULT_TIME_ZONE);
  return formatterFor(calendarDate ? DATE_PARTS : DATE_TIME_PARTS, locale, timeZone).format(
    new Date(timestamp),
  );
}

/** The full timestamp with seconds and time zone, for a hover title; undefined for a calendar date. */
export function formatIsoDateTitle(
  iso: string,
  options: DateFormatOptions = {},
): string | undefined {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp) || isCalendarDate(iso)) return undefined;
  return formatterFor(
    FULL_PARTS,
    options.locale ?? DEFAULT_LOCALE,
    options.timeZone ?? DEFAULT_TIME_ZONE,
  ).format(new Date(timestamp));
}
