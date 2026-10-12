/**
 * Organisation or viewer presentation settings for dates. The host passes the locale (a BCP 47
 * tag) and IANA time zone; the renderer never reads the server's or browser's own defaults.
 */
export type DateFormatOptions = Readonly<{
  locale?: string | undefined;
  timeZone?: string | undefined;
}>;

/** Fixed fallbacks, so server and browser output stay identical when the host supplies none. */
const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIME_ZONE = "UTC";

const DATE_PARTS: Intl.DateTimeFormatOptions = { year: "numeric", month: "short", day: "numeric" };
const MAXIMUM_CACHED_FORMATTERS = 64;
const formatters = new Map<string, Intl.DateTimeFormat>();

/** One cached formatter; an unsupported locale or time zone uses the fixed fallbacks. */
const formatterFor = (locale: string, timeZone: string): Intl.DateTimeFormat => {
  const key = `${locale}\u0000${timeZone}`;
  const cached = formatters.get(key);
  if (cached !== undefined) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(locale, { ...DATE_PARTS, timeZone });
  } catch {
    formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, { ...DATE_PARTS, timeZone: DEFAULT_TIME_ZONE });
  }
  if (formatters.size >= MAXIMUM_CACHED_FORMATTERS) formatters.clear();
  formatters.set(key, formatter);
  return formatter;
};

/**
 * Formats a validated ISO calendar date or offset timestamp for presentation in the given
 * locale and time zone. A calendar date carries no time zone, so it is formatted in UTC to avoid
 * shifting its day; a timestamp shows the day in the viewer's time zone.
 */
export function formatIsoDate(iso: string, options: DateFormatOptions = {}): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return iso;
  const locale = options.locale ?? DEFAULT_LOCALE;
  const timeZone = iso.length === 10 ? "UTC" : (options.timeZone ?? DEFAULT_TIME_ZONE);
  return formatterFor(locale, timeZone).format(new Date(timestamp));
}
