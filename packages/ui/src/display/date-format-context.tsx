"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  formatIsoDate,
  formatIsoDateTitle,
  INVALID_DATE_TEXT,
  type DateFormatOptions,
} from "./date-format";

const DateFormatContext = createContext<DateFormatOptions>({});

const NO_VIEWER_SETTINGS: DateFormatOptions = Object.freeze({});
let browserSettings: DateFormatOptions | undefined;

const subscribeToNothing = (): (() => void) => () => undefined;
const readBrowserSettings = (): DateFormatOptions => {
  browserSettings ??= Object.freeze({
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  return browserSettings;
};
const readServerSettings = (): DateFormatOptions => NO_VIEWER_SETTINGS;

/**
 * The effective presentation settings: those the host supplied, otherwise the viewer's browser
 * locale and time zone. The server and the hydrating client render with fixed fallbacks and the
 * browser settings apply right after, so there is no hydration mismatch.
 */
function useDateFormatOptions(): DateFormatOptions {
  const supplied = useContext(DateFormatContext);
  const viewer = useSyncExternalStore(subscribeToNothing, readBrowserSettings, readServerSettings);
  return useMemo(
    () => ({
      locale: supplied.locale ?? viewer.locale,
      timeZone: supplied.timeZone ?? viewer.timeZone,
    }),
    [supplied.locale, supplied.timeZone, viewer],
  );
}

/** Supplies the organisation or viewer locale and time zone to every date rendered below it. */
export function DateFormatProvider({
  locale,
  timeZone,
  children,
}: Readonly<DateFormatOptions & { children: ReactNode }>): ReactElement {
  const format = useMemo<DateFormatOptions>(() => ({ locale, timeZone }), [locale, timeZone]);
  return <DateFormatContext.Provider value={format}>{children}</DateFormatContext.Provider>;
}

/** Logs an unreadable stored date once per mount, with a stable code and never the value itself. */
function useInvalidDateLog(invalid: boolean): void {
  useEffect(() => {
    if (invalid) console.error("[display] date value refused DATE_VALUE_INVALID");
  }, [invalid]);
}

/** Text of one ISO date or timestamp in the surrounding locale and time zone. */
export function FormattedDate({ iso }: Readonly<{ iso: string }>): ReactElement {
  const text = formatIsoDate(iso, useDateFormatOptions());
  useInvalidDateLog(text === undefined);
  return <>{text ?? INVALID_DATE_TEXT}</>;
}

/**
 * One date or timestamp as a time element: the readable text in the viewer's locale and time zone,
 * with the full timestamp on hover. An unreadable value shows a located error state.
 */
export function FormattedTime({
  iso,
  className,
}: Readonly<{ iso: string; className?: string }>): ReactElement {
  const options = useDateFormatOptions();
  const text = formatIsoDate(iso, options);
  useInvalidDateLog(text === undefined);
  if (text === undefined)
    return (
      <span className={className} role="alert" data-vortex-date-error="DATE_VALUE_INVALID">
        {INVALID_DATE_TEXT}
      </span>
    );
  const title = formatIsoDateTitle(iso, options);
  return (
    <time className={className} dateTime={iso} {...(title === undefined ? {} : { title })}>
      {text}
    </time>
  );
}
