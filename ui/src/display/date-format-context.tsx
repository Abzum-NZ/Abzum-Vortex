"use client";

import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from "react";
import { formatIsoDate, type DateFormatOptions } from "./date-format";

const DateFormatContext = createContext<DateFormatOptions>({});

/** Supplies the organisation or viewer locale and time zone to every date rendered below it. */
export function DateFormatProvider({
  locale,
  timeZone,
  children,
}: Readonly<DateFormatOptions & { children: ReactNode }>): ReactElement {
  const format = useMemo<DateFormatOptions>(() => ({ locale, timeZone }), [locale, timeZone]);
  return <DateFormatContext.Provider value={format}>{children}</DateFormatContext.Provider>;
}

/** Text of one ISO date or timestamp in the surrounding locale and time zone. */
export function FormattedDate({ iso }: Readonly<{ iso: string }>): ReactElement {
  return <>{formatIsoDate(iso, useContext(DateFormatContext))}</>;
}
